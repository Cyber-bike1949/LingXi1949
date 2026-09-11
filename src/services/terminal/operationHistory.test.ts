import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationHistory } from './operationHistory.ts';
import { serializeShortcutStepInput, ShortcutGroupStore, type ShortcutStep } from './shortcutGroupStore.ts';

function record(history: OperationHistory, sequence: number, payload = `echo ${sequence}`) {
  return history.record({ sessionId: 's', deviceKey: 'd', kind: 'shell', summary: payload, payload, captureQuality: 'complete', completion: 'resolved', source: 'user' })!;
}

test('history isolates sessions, filters non-user input and keeps the latest limit', () => {
  const history = new OperationHistory(2);
  record(history, 1); record(history, 2); record(history, 3);
  assert.deepEqual(history.list('s').map((item) => item.payload), ['echo 2', 'echo 3']);
  history.setEnabled('s', false);
  assert.equal(history.record({ sessionId: 's', deviceKey: 'd', kind: 'shell', summary: 'replay', payload: 'replay', captureQuality: 'complete', completion: 'resolved', source: 'replay' }), null);
  assert.deepEqual(history.list('other'), []);
});

test('a shell completion resolves only the latest pending shell operation', () => {
  const history = new OperationHistory();
  history.record({ sessionId: 's', deviceKey: 'd', kind: 'shell', summary: 'first', payload: 'first', captureQuality: 'complete', completion: 'resolved', source: 'user' });
  history.record({ sessionId: 's', deviceKey: 'd', kind: 'shell', summary: 'second', payload: 'second', captureQuality: 'complete', completion: 'pending', source: 'user' });
  history.resolveLatestShell('s');
  assert.deepEqual(history.list('s').map((item) => item.completion), ['resolved', 'resolved']);
});

test('shortcut groups persist deep-copied steps in sequence order', async () => {
  let saved: import('./shortcutGroupStore.ts').ShortcutStoreData = {};
  const store = new ShortcutGroupStore(async () => saved, async (data) => { saved = structuredClone(data); });
  await store.load();
  const history = new OperationHistory();
  const first = record(history, 1, 'first'); const second = record(history, 2, 'second');
  const group = await store.create('d', 'Demo', [second, first]);
  assert.deepEqual(group.steps.map((step) => step.payload), ['first', 'second']);
  await assert.rejects(store.create('d', 'Demo', [first]), /DUPLICATE_NAME/);
  await store.remove(group.id);
  assert.deepEqual(store.list('d'), []);
});

test('history notifies subscribers only when a user record is added', () => {
  const history = new OperationHistory();
  const payloads: string[] = [];
  const cleanup = history.subscribe((item) => payloads.push(item.payload));
  record(history, 1, 'first');
  history.record({ sessionId: 's', deviceKey: 'd', kind: 'shell', summary: 'ignored', payload: 'ignored', captureQuality: 'complete', completion: 'resolved', source: 'replay' });
  cleanup();
  record(history, 2, 'second');
  assert.deepEqual(payloads, ['first']);
});

test('shortcut replay submits command steps and preserves semantic key payloads', () => {
  const base: ShortcutStep = { id: 'step', kind: 'text', summary: '/permissions', payload: '/permissions', captureQuality: 'complete', completion: 'resolved', sequence: 1 };
  assert.equal(serializeShortcutStepInput(base), '/permissions\r');
  assert.equal(serializeShortcutStepInput({ ...base, kind: 'shell', payload: 'codex\r' }), 'codex\r');
  assert.equal(serializeShortcutStepInput({ ...base, kind: 'key', payload: '\x1b[A' }), '\x1b[A');
  assert.equal(serializeShortcutStepInput({ ...base, kind: 'confirm', payload: '\r' }), '\r');
});

test('history preserves an empty Enter as a confirm operation', () => {
  const history = new OperationHistory();
  const enter = history.record({ sessionId: 's', deviceKey: 'd', kind: 'confirm', summary: 'Enter', payload: '\r', captureQuality: 'complete', completion: 'pending', source: 'user' });
  assert.equal(enter?.summary, 'Enter');
  assert.equal(enter?.payload, '\r');
});
