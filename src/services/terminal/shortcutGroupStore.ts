import type { OperationRecord } from './operationHistory.ts';

export interface ShortcutStep {
  id: string;
  kind: OperationRecord['kind'];
  summary: string;
  payload: string;
  captureQuality: OperationRecord['captureQuality'];
  completion: OperationRecord['completion'];
  sequence: number;
  outputMatch?: string;
}

export interface ShortcutGroup {
  id: string;
  deviceKey: string;
  name: string;
  createdAt: number;
  creationOrder: number;
  schemaVersion: 1;
  steps: ShortcutStep[];
}

export interface ShortcutStoreData { deviceShortcutGroups?: ShortcutGroup[]; shortcutGroupsVersion?: number }

export function serializeShortcutStepInput(step: ShortcutStep): string {
  const submitsCommand = step.kind === 'shell' || step.kind === 'text';
  if (!submitsCommand || /[\r\n]$/.test(step.payload)) return step.payload;
  return `${step.payload}\r`;
}

export class ShortcutGroupStore {
  private readonly read: () => Promise<ShortcutStoreData>;
  private readonly write: (data: ShortcutStoreData) => Promise<void>;
  private groups: ShortcutGroup[];
  private order: number;
  private readonly subscribers = new Set<(groups: ShortcutGroup[]) => void>();

  constructor(read: () => Promise<ShortcutStoreData>, write: (data: ShortcutStoreData) => Promise<void>) {
    this.read = read;
    this.write = write;
    this.groups = [];
    this.order = 0;
  }

  async load(): Promise<void> {
    const data = await this.read();
    this.groups = Array.isArray(data.deviceShortcutGroups) ? data.deviceShortcutGroups.filter((g) => g?.schemaVersion === 1) : [];
    this.order = this.groups.reduce((max, group) => Math.max(max, group.creationOrder), 0);
  }

  subscribe(callback: (groups: ShortcutGroup[]) => void): () => void { this.subscribers.add(callback); return () => this.subscribers.delete(callback); }
  list(deviceKey?: string): ShortcutGroup[] { return this.groups.filter((g) => deviceKey === undefined || g.deviceKey === deviceKey).sort((a, b) => b.creationOrder - a.creationOrder).map((g) => ({ ...g, steps: g.steps.map((s) => ({ ...s })) })); }

  async create(deviceKey: string, name: string, records: OperationRecord[], outputMatches: ReadonlyMap<string, string> = new Map()): Promise<ShortcutGroup> {
    const normalized = name.trim();
    if (!records.length) throw new Error('EMPTY_SELECTION');
    if (!normalized) throw new Error('EMPTY_NAME');
    if (this.groups.some((g) => g.deviceKey === deviceKey && g.name === normalized)) throw new Error('DUPLICATE_NAME');
    const steps = [...records].sort((a, b) => a.sequence - b.sequence).map(({ id, kind, summary, payload, captureQuality, completion, sequence }) => {
      const outputMatch = outputMatches.get(id)?.trim();
      return { id, kind, summary, payload, captureQuality, completion, sequence, ...(outputMatch ? { outputMatch } : {}) };
    });
    if (steps.some((step) => step.captureQuality === 'unavailable')) throw new Error('UNAVAILABLE_STEP');
    const group: ShortcutGroup = { id: `shortcut:${crypto.randomUUID()}`, deviceKey, name: normalized, createdAt: Date.now(), creationOrder: ++this.order, schemaVersion: 1, steps };
    const next = [...this.groups, group];
    await this.write({ deviceShortcutGroups: next, shortcutGroupsVersion: 1 });
    this.groups = next;
    this.notify();
    return group;
  }

  async remove(id: string): Promise<void> {
    const next = this.groups.filter((group) => group.id !== id);
    if (next.length === this.groups.length) return;
    await this.write({ deviceShortcutGroups: next, shortcutGroupsVersion: 1 });
    this.groups = next;
    this.notify();
  }

  private notify(): void { const snapshot = this.list(); for (const subscriber of this.subscribers) subscriber(snapshot); }
}
