import type { ShortcutGroup, ShortcutStep } from './shortcutGroupStore.ts';

export type ReplayState = 'preparing' | 'sending' | 'waiting' | 'paused' | 'completed' | 'stopped';
export type DispatchState = 'unsent' | 'sent' | 'confirmed' | 'unknown';
export type Completion = 'complete' | 'failed' | 'unknown';

export interface ReplayTerminal { sessionId: string; deviceKey: string; write(step: ShortcutStep): Promise<void>; }
export interface ReplayAdapter { inspect(step: ShortcutStep, terminal: ReplayTerminal): Promise<boolean | 'unknown'>; observeCompletion(step: ShortcutStep, terminal: ReplayTerminal): Promise<Completion>; }
export interface ReplaySnapshot { runId: string; state: ReplayState; stepIndex: number; totalSteps: number; groupName: string; dispatchState: DispatchState; pauseReason?: string }

export class ShortcutReplayController {
  private readonly runs = new Map<string, { snapshot: ReplaySnapshot; generation: number; group: ShortcutGroup; terminal: ReplayTerminal; adapter: ReplayAdapter }>();
  private readonly locks = new Set<string>();
  private readonly listeners = new Map<string, Set<(snapshot: ReplaySnapshot) => void>>();

  start(group: ShortcutGroup, terminal: ReplayTerminal, adapter: ReplayAdapter): Promise<string> {
    if (group.deviceKey !== terminal.deviceKey) throw new Error('DEVICE_MISMATCH');
    if (this.locks.has(terminal.sessionId)) throw new Error('ALREADY_RUNNING');
    const runId = crypto.randomUUID();
    const snapshot: ReplaySnapshot = { runId, state: 'preparing', stepIndex: 0, totalSteps: group.steps.length, groupName: group.name, dispatchState: 'unsent' };
    this.locks.add(terminal.sessionId);
    this.runs.set(runId, { snapshot, generation: 0, group: structuredClone(group), terminal, adapter });
    void this.advance(runId);
    return Promise.resolve(runId);
  }

  get(runId: string): ReplaySnapshot | null {
    const snapshot = this.runs.get(runId)?.snapshot;
    return snapshot ? { ...snapshot } : null;
  }

  subscribe(runId: string, listener: (snapshot: ReplaySnapshot) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    const snapshot = this.get(runId);
    if (snapshot) listener(snapshot);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async continue(runId: string, action: 'wait' | 'confirmed' | 'send' = 'send'): Promise<void> {
    const run = this.require(runId);
    if (run.snapshot.state !== 'paused') return;
    if (action === 'send' && run.snapshot.dispatchState !== 'unsent') return;
    if (action === 'confirmed' && run.snapshot.dispatchState === 'unsent') return;
    const step = run.group.steps[run.snapshot.stepIndex];
    if (action === 'confirmed') {
      run.snapshot.dispatchState = 'confirmed';
      run.snapshot.stepIndex += 1;
      run.snapshot.dispatchState = 'unsent';
    } else if (action === 'wait') {
      if (!['sent', 'unknown'].includes(run.snapshot.dispatchState) || !step) return;
      run.snapshot.state = 'waiting';
      this.emit(runId);
      await this.waitForCompletion(runId, run, step);
      return;
    }
    run.snapshot.state = 'preparing';
    this.emit(runId);
    await this.advance(runId);
  }

  stop(runId: string): void {
    const run = this.require(runId);
    run.generation += 1;
    run.snapshot.state = 'stopped';
    this.locks.delete(run.terminal.sessionId);
    this.emit(runId);
  }

  stopDevice(deviceKey: string): void {
    for (const [runId, run] of this.runs) {
      if (run.terminal.deviceKey === deviceKey && run.snapshot.state !== 'completed' && run.snapshot.state !== 'stopped') {
        this.stop(runId);
      }
    }
  }

  private async advance(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.snapshot.state === 'stopped' || run.snapshot.state === 'completed') return;
    const step = run.group.steps[run.snapshot.stepIndex];
    if (!step) { run.snapshot.state = 'completed'; this.locks.delete(run.terminal.sessionId); this.emit(runId); return; }
    const generation = run.generation;
    let ready: boolean | 'unknown';
    try {
      ready = await run.adapter.inspect(step, run.terminal);
    } catch {
      if (this.current(runId, generation)) this.pause(runId, run, '目标状态读取失败');
      return;
    }
    if (!this.current(runId, generation)) return;
    if (ready === 'unknown') return this.pause(runId, run, '目标状态未知');
    if (!ready) return this.pause(runId, run, '目标会话不匹配');
    run.snapshot.state = 'sending';
    run.snapshot.dispatchState = 'sent';
    this.emit(runId);
    try { await run.terminal.write(step); } catch {
      if (this.current(runId, generation)) this.pause(runId, run, '发送结果未知', 'unknown');
      return;
    }
    if (!this.current(runId, generation)) return;
    run.snapshot.state = 'waiting';
    this.emit(runId);
    await this.waitForCompletion(runId, run, step, generation);
  }

  private async waitForCompletion(
    runId: string,
    run: { snapshot: ReplaySnapshot; generation: number; group: ShortcutGroup; terminal: ReplayTerminal; adapter: ReplayAdapter },
    step: ShortcutStep,
    generation = run.generation,
  ): Promise<void> {
    let result: Completion;
    try {
      result = await run.adapter.observeCompletion(step, run.terminal);
    } catch {
      result = 'unknown';
    }
    if (!this.current(runId, generation)) return;
    if (result === 'complete') { run.snapshot.dispatchState = 'confirmed'; run.snapshot.stepIndex += 1; run.snapshot.dispatchState = 'unsent'; run.snapshot.state = 'preparing'; this.emit(runId); return this.advance(runId); }
    this.pause(runId, run, result === 'failed' ? '步骤执行失败' : '完成状态未知', result === 'unknown' ? 'unknown' : 'sent');
  }

  private pause(runId: string, run: { snapshot: ReplaySnapshot }, reason: string, state: DispatchState = 'unsent'): void { run.snapshot.state = 'paused'; run.snapshot.pauseReason = reason; run.snapshot.dispatchState = state; this.emit(runId); }
  private emit(runId: string): void { const snapshot = this.get(runId); if (snapshot) for (const listener of this.listeners.get(runId) ?? []) listener(snapshot); }
  private current(runId: string, generation: number): boolean { const run = this.runs.get(runId); return run !== undefined && run.generation === generation && run.snapshot.state !== 'stopped'; }
  private require(runId: string) { const run = this.runs.get(runId); if (!run) throw new Error('INVALID_RUN'); return run; }
}
