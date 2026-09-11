export type OperationKind = 'shell' | 'text' | 'key' | 'confirm';
export type CaptureQuality = 'complete' | 'manual' | 'unavailable';

export interface OperationRecord {
  id: string;
  sessionId: string;
  deviceKey: string;
  sequence: number;
  timestamp: number;
  kind: OperationKind;
  summary: string;
  payload: string;
  captureQuality: CaptureQuality;
  completion: 'pending' | 'resolved' | 'manual';
}

export type InputSource = 'user' | 'replay' | 'protocol' | 'preset';

export class OperationHistory {
  private readonly limit: number;
  private readonly records = new Map<string, OperationRecord[]>();
  private readonly enabled = new Map<string, boolean>();
  private readonly subscribers = new Set<(record: OperationRecord) => void>();
  private sequence = 0;

  constructor(limit = 100) {
    this.limit = limit;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('history limit must be positive');
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    this.enabled.set(sessionId, enabled);
  }

  isEnabled(sessionId: string): boolean { return this.enabled.get(sessionId) ?? true; }

  clear(sessionId: string): void { this.records.delete(sessionId); }

  list(sessionId: string): OperationRecord[] { return [...(this.records.get(sessionId) ?? [])]; }

  subscribe(listener: (record: OperationRecord) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  resolveLatestShell(sessionId: string): void {
    const records = this.records.get(sessionId);
    if (!records) return;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.kind === 'shell' && record.completion === 'pending') {
        records[index] = { ...record, completion: 'resolved' };
        return;
      }
    }
  }

  record(input: Omit<OperationRecord, 'id' | 'sequence' | 'timestamp'> & { source?: InputSource }): OperationRecord | null {
    if (!this.isEnabled(input.sessionId) || input.source !== undefined && input.source !== 'user') return null;
    const hasPayload = input.kind === 'shell' || input.kind === 'text'
      ? input.payload.trim().length > 0
      : input.payload.length > 0;
    if (input.captureQuality === 'unavailable' || !hasPayload) return null;
    const record: OperationRecord = {
      ...input,
      id: `${input.sessionId}:${++this.sequence}`,
      sequence: this.sequence,
      timestamp: Date.now(),
    };
    const history = this.records.get(input.sessionId) ?? [];
    history.push(record);
    while (history.length > this.limit) history.shift();
    this.records.set(input.sessionId, history);
    for (const listener of this.subscribers) listener(record);
    return record;
  }
}
