import assert from 'node:assert/strict';
import test from 'node:test';
import { ShortcutReplayController } from './shortcutReplayController.ts';
import type { ShortcutGroup } from './shortcutGroupStore.ts';

const group: ShortcutGroup = { id: 'g', deviceKey: 'd', name: 'demo', createdAt: 1, creationOrder: 1, schemaVersion: 1, steps: [{ id: 's', kind: 'shell', summary: 'echo', payload: 'echo\r', captureQuality: 'complete', completion: 'resolved', sequence: 1 }] };

test('replay writes once, waits for adapter completion and completes', async () => {
  const writes: string[] = [];
  let resolve!: () => void;
  const controller = new ShortcutReplayController();
  const runId = await controller.start(group, { sessionId: 's', deviceKey: 'd', async write(step) { writes.push(step.payload); } }, { async inspect() { return true; }, async observeCompletion() { await new Promise<void>((r) => { resolve = r; }); return 'complete'; } });
  for (let i = 0; i < 20 && resolve === undefined; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(writes.length, 1);
  resolve();
  for (let i = 0; i < 20 && controller.get(runId)?.state !== 'completed'; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(controller.get(runId)?.state, 'completed');
});

test('unknown inspection pauses without writing and stop invalidates late work', async () => {
  const writes: string[] = [];
  const controller = new ShortcutReplayController();
  const runId = await controller.start(group, { sessionId: 's', deviceKey: 'd', async write(step) { writes.push(step.payload); } }, { async inspect() { return 'unknown'; }, async observeCompletion() { return 'complete'; } });
  for (let i = 0; i < 20 && controller.get(runId)?.state !== 'paused'; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(writes, []);
  controller.stop(runId);
  assert.equal(controller.get(runId)?.state, 'stopped');
});

test('waiting continuation observes again without resending the step', async () => {
  const writes: string[] = [];
  let observations = 0;
  const controller = new ShortcutReplayController();
  const runId = await controller.start(group, { sessionId: 's', deviceKey: 'd', async write(step) { writes.push(step.payload); } }, {
    async inspect() { return true; },
    async observeCompletion() { observations += 1; return observations === 1 ? 'unknown' : 'complete'; },
  });
  for (let i = 0; i < 20 && controller.get(runId)?.state !== 'paused'; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(controller.get(runId)?.dispatchState, 'unknown');
  await controller.continue(runId, 'wait');
  for (let i = 0; i < 20 && controller.get(runId)?.state !== 'completed'; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(writes.length, 1);
  assert.equal(observations, 2);
  assert.equal(controller.get(runId)?.state, 'completed');
});

test('unknown completion cannot be resent by the default continuation', async () => {
  let writes = 0;
  const controller = new ShortcutReplayController();
  const id = await controller.start(group, { sessionId: 's', deviceKey: 'd', async write() { writes += 1; } }, {
    async inspect() { return true; }, async observeCompletion() { throw new Error('disconnected'); },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.get(id)?.state, 'paused');
  await controller.continue(id);
  assert.equal(writes, 1);
  await controller.continue(id, 'confirmed');
  assert.equal(controller.get(id)?.state, 'completed');
});

test('late write failure cannot revive a stopped run', async () => {
  let rejectWrite!: (error: Error) => void;
  const controller = new ShortcutReplayController();
  const id = await controller.start(group, { sessionId: 's', deviceKey: 'd', write() {
    return new Promise<void>((_, reject) => { rejectWrite = reject; });
  } }, { async inspect() { return true; }, async observeCompletion() { return 'complete'; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.stop(id);
  rejectWrite(new Error('closed'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.get(id)?.state, 'stopped');
});

test('replay keeps key steps distinct from shell steps', async () => {
  const keyGroup: ShortcutGroup = { ...group, steps: [{ ...group.steps[0], kind: 'key', summary: 'ArrowDown', payload: '\u001b[B' }] };
  const received: Array<{ kind: string; payload: string }> = [];
  const controller = new ShortcutReplayController();
  const id = await controller.start(keyGroup, { sessionId: 'keys', deviceKey: 'd', async write(step) { received.push(step); } }, {
    async inspect() { return true; }, async observeCompletion() { return 'complete'; },
  });
  for (let index = 0; index < 20 && controller.get(id)?.state !== 'completed'; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(received[0]?.kind, 'key');
  assert.equal(received[0]?.payload, '\u001b[B');
});
