export interface ModificationEvent {
  deviceKey: string;
  path: string;
  version: number;
  /** Target-process epoch; events from older epochs are ignored. */
  epoch?: string;
  /** Monotonic sequence within an epoch. */
  sequence?: number;
  eventId?: string;
}

interface FileState { version: number; acknowledged: number; epoch?: string }

/** Window-local acknowledgement state for transfer-created modifications. */
export class DirectoryModificationStore {
  private readonly files = new Map<string, FileState>();
  private readonly folderCounts = new Map<string, number>();
  private readonly subscribers = new Set<() => void>();
  private readonly epochs = new Map<string, string>();
  private readonly maxSequences = new Map<string, number>();
  private readonly refreshBarriers = new Map<string, number>();
  private readonly eventIds = new Map<string, { deviceKey: string; epoch?: string; sequence?: number }>();

  subscribe(callback: () => void): () => void { this.subscribers.add(callback); return () => this.subscribers.delete(callback); }

  /** Starts a new target-process epoch without clearing already confirmed marks. */
  beginEpoch(deviceKey: string, epoch: string): void {
    if (!epoch.trim()) return;
    if (this.epochs.get(deviceKey) === epoch) return;
    this.epochs.set(deviceKey, epoch);
    this.maxSequences.set(deviceKey, 0);
    this.refreshBarriers.set(deviceKey, 0);
  }

  /** Forgets the process epoch when a connection is replaced; the next receipt establishes it. */
  resetEpoch(deviceKey: string): void {
    this.epochs.delete(deviceKey);
    this.maxSequences.delete(deviceKey);
    this.refreshBarriers.delete(deviceKey);
  }

  currentEpoch(deviceKey: string): string | null { return this.epochs.get(deviceKey) ?? null; }

  mark(event: ModificationEvent): void {
    if (!this.acceptEvent(event)) return;
    const key = `${event.deviceKey}\0${event.path}`;
    const current = this.files.get(key);
    const epochChanged = event.epoch !== undefined && current !== undefined && event.epoch !== current.epoch;
    if (!current || epochChanged || event.version > current.version) {
      const wasMarked = current !== undefined && current.version > current.acknowledged;
      const acknowledged = epochChanged ? 0 : current?.acknowledged ?? 0;
      this.files.set(key, { version: event.version, acknowledged, epoch: event.epoch ?? current?.epoch });
      if (!wasMarked && event.version > acknowledged) this.adjustAncestors(event.deviceKey, event.path, 1);
      this.notify();
    }
  }

  private acceptEvent(event: ModificationEvent): boolean {
    if (event.eventId && this.eventIds.has(`${event.deviceKey}\0${event.eventId}`)) return false;
    if (event.epoch) {
      const currentEpoch = this.epochs.get(event.deviceKey);
      if (currentEpoch !== undefined && currentEpoch !== event.epoch) return false;
      if (currentEpoch === undefined) this.epochs.set(event.deviceKey, event.epoch);
      if (event.sequence !== undefined) {
        const barrier = this.refreshBarriers.get(event.deviceKey) ?? 0;
        if (event.sequence <= barrier) return false;
        const maximum = this.maxSequences.get(event.deviceKey) ?? 0;
        this.maxSequences.set(event.deviceKey, Math.max(maximum, event.sequence));
      }
    }
    if (event.eventId) this.eventIds.set(`${event.deviceKey}\0${event.eventId}`, {
      deviceKey: event.deviceKey,
      epoch: event.epoch,
      sequence: event.sequence,
    });
    return true;
  }

  /** Marks a path with the next local version when a transfer succeeds. */
  markPath(deviceKey: string, path: string): number {
    const next = (this.version(deviceKey, path) ?? 0) + 1;
    const epoch = this.epochs.get(deviceKey);
    const sequence = epoch ? (this.maxSequences.get(deviceKey) ?? 0) + 1 : undefined;
    this.mark({ deviceKey, path, version: next, epoch, sequence });
    return next;
  }

  acknowledge(deviceKey: string, path: string, version: number): void {
    const key = `${deviceKey}\0${path}`;
    const current = this.files.get(key);
    if (!current || version < current.version || version <= current.acknowledged) return;
    const wasMarked = current.version > current.acknowledged;
    current.acknowledged = version;
    if (wasMarked && current.version <= current.acknowledged) this.adjustAncestors(deviceKey, path, -1);
    this.notify();
  }

  isMarked(deviceKey: string, path: string): boolean {
    const state = this.files.get(`${deviceKey}\0${path}`);
    return state !== undefined && state.version > state.acknowledged;
  }

  version(deviceKey: string, path: string): number | null { return this.files.get(`${deviceKey}\0${path}`)?.version ?? null; }

  clearAll(): void {
    for (const [deviceKey, maximum] of this.maxSequences) this.refreshBarriers.set(deviceKey, maximum);
    if (this.files.size) {
      for (const state of this.files.values()) state.acknowledged = state.version;
      this.folderCounts.clear();
      this.notify();
    }
  }

  applyRefreshBarrier(deviceKey: string, epoch: string, sequence: number): void {
    const currentEpoch = this.epochs.get(deviceKey);
    if (currentEpoch !== epoch) this.beginEpoch(deviceKey, epoch);
    this.refreshBarriers.set(deviceKey, Math.max(this.refreshBarriers.get(deviceKey) ?? 0, sequence));
    this.maxSequences.set(deviceKey, Math.max(this.maxSequences.get(deviceKey) ?? 0, sequence));
    for (const [eventId, event] of this.eventIds) {
      if (event.deviceKey === deviceKey && event.epoch === epoch && event.sequence !== undefined && event.sequence <= sequence) {
        this.eventIds.delete(eventId);
      }
    }
    const prefix = `${deviceKey}\0`;
    let changed = false;
    for (const [key, state] of this.files) {
      if (key.startsWith(prefix) && state.epoch === epoch && state.version <= sequence && state.acknowledged < state.version) {
        this.adjustAncestors(deviceKey, key.slice(prefix.length), -1);
        state.acknowledged = state.version;
        changed = true;
      }
    }
    if (changed) this.notify();
  }
  remove(deviceKey: string, path: string): void {
    const key = `${deviceKey}\0${path}`;
    const state = this.files.get(key);
    if (state && state.version > state.acknowledged) this.adjustAncestors(deviceKey, path, -1);
    this.files.delete(key);
  }

  removeDevice(deviceKey: string): void {
    const prefix = `${deviceKey}\0`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) this.files.delete(key);
    for (const key of this.folderCounts.keys()) if (key.startsWith(prefix)) this.folderCounts.delete(key);
    this.epochs.delete(deviceKey);
    this.maxSequences.delete(deviceKey);
    this.refreshBarriers.delete(deviceKey);
    for (const [eventId, event] of this.eventIds) if (event.deviceKey === deviceKey) this.eventIds.delete(eventId);
    this.notify();
  }

  dispose(): void {
    this.files.clear();
    this.folderCounts.clear();
    this.epochs.clear();
    this.maxSequences.clear();
    this.refreshBarriers.clear();
    this.eventIds.clear();
    this.subscribers.clear();
  }

  /** A folder is marked only when one of its descendant files is marked. */
  isFolderMarked(deviceKey: string, folderPath: string, separator = '/'): boolean {
    void separator;
    return (this.folderCounts.get(`${deviceKey}\0${folderPath.replace(/[\\/]$/, '')}`) ?? 0) > 0;
  }

  private adjustAncestors(deviceKey: string, path: string, delta: 1 | -1): void {
    const normalized = path.replace(/[\\/]$/, '');
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] !== '/' && normalized[index] !== '\\') continue;
      const folder = normalized.slice(0, index);
      if (!folder || /^[A-Za-z]:$/.test(folder)) continue;
      const key = `${deviceKey}\0${folder}`;
      const next = (this.folderCounts.get(key) ?? 0) + delta;
      if (next > 0) this.folderCounts.set(key, next); else this.folderCounts.delete(key);
    }
  }

  private notify(): void { for (const subscriber of this.subscribers) subscriber(); }
}
