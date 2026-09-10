import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationHistory } from './operationHistory.ts';
import { ShortcutGroupStore } from './shortcutGroupStore.ts';

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
