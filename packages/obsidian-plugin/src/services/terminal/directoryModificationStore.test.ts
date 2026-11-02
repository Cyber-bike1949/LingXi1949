import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectoryModificationStore } from './directoryModificationStore.ts';

test('marks files by version, ignores stale acknowledgement and aggregates folders', () => {
  const store = new DirectoryModificationStore();
  store.mark({ deviceKey: 'd', path: 'docs/demo.md', version: 2 });
  store.mark({ deviceKey: 'd', path: 'docs/demo.md', version: 1 });
  assert.equal(store.isMarked('d', 'docs/demo.md'), true);
  assert.equal(store.isFolderMarked('d', 'docs'), true);
  store.acknowledge('d', 'docs/demo.md', 1);
  assert.equal(store.isMarked('d', 'docs/demo.md'), true);
  store.acknowledge('d', 'docs/demo.md', 2);
  assert.equal(store.isFolderMarked('d', 'docs'), false);
});

test('clearAll acknowledges every known path without deleting versions', () => {
  const store = new DirectoryModificationStore();
  store.mark({ deviceKey: 'd', path: 'a.md', version: 1 });
  store.clearAll();
  assert.equal(store.isMarked('d', 'a.md'), false);
  assert.equal(store.version('d', 'a.md'), 1);
  store.mark({ deviceKey: 'd', path: 'a.md', version: 2 });
  assert.equal(store.isMarked('d', 'a.md'), true);
});

test('markPath advances a path version after each successful transfer', () => {
  const store = new DirectoryModificationStore();
  assert.equal(store.markPath('d', '/tmp/a.md'), 1);
  assert.equal(store.markPath('d', '/tmp/a.md'), 2);
  assert.equal(store.version('d', '/tmp/a.md'), 2);
  assert.equal(store.isMarked('d', '/tmp/a.md'), true);
});

test('epoch and sequence form a refresh barrier for late receipts', () => {
  const store = new DirectoryModificationStore();
  store.beginEpoch('d', 'epoch-1');
  store.mark({ deviceKey: 'd', path: '/a', version: 1, epoch: 'epoch-1', sequence: 2, eventId: 'e2' });
  store.mark({ deviceKey: 'd', path: '/b', version: 1, epoch: 'epoch-1', sequence: 1, eventId: 'late' });
  assert.equal(store.isMarked('d', '/b'), true, 'out-of-order concurrent commits are still real changes');
  store.clearAll();
  store.mark({ deviceKey: 'd', path: '/c', version: 1, epoch: 'epoch-1', sequence: 1, eventId: 'older-than-refresh' });
  assert.equal(store.isMarked('d', '/c'), false);
  store.mark({ deviceKey: 'd', path: '/a', version: 2, epoch: 'epoch-0', sequence: 99, eventId: 'old' });
  assert.equal(store.version('d', '/a'), 1);
  store.mark({ deviceKey: 'd', path: '/a', version: 3, epoch: 'epoch-1', sequence: 3, eventId: 'e3' });
  assert.equal(store.version('d', '/a'), 3);
});

test('resetEpoch lets the first receipt from a reconnected agent establish its process epoch', () => {
  const store = new DirectoryModificationStore();
  store.beginEpoch('d', 'old');
  store.resetEpoch('d');
  store.mark({ deviceKey: 'd', path: '/a', version: 1, epoch: 'new', sequence: 1 });
  assert.equal(store.currentEpoch('d'), 'new');
  assert.equal(store.isMarked('d', '/a'), true);
});

test('sequence restart in a new epoch can modify a path with a larger old sequence', () => {
  const store = new DirectoryModificationStore();
  store.mark({ deviceKey: 'd', path: '/a', version: 20, epoch: 'old', sequence: 20 });
  store.acknowledge('d', '/a', 20);
  store.resetEpoch('d');
  store.mark({ deviceKey: 'd', path: '/a', version: 1, epoch: 'new', sequence: 1 });
  assert.equal(store.version('d', '/a'), 1);
  assert.equal(store.isMarked('d', '/a'), true);
});

test('agent snapshot barrier removes commits at the snapshot and accepts later commits', () => {
  const store = new DirectoryModificationStore();
  store.mark({ deviceKey: 'd', path: '/before', version: 4, epoch: 'e', sequence: 4 });
  store.clearAll();
  store.mark({ deviceKey: 'd', path: '/in-flight', version: 5, epoch: 'e', sequence: 5 });
  assert.equal(store.isMarked('d', '/in-flight'), true);
  store.applyRefreshBarrier('d', 'e', 5);
  assert.equal(store.isMarked('d', '/in-flight'), false);
  store.mark({ deviceKey: 'd', path: '/after', version: 6, epoch: 'e', sequence: 6 });
  assert.equal(store.isMarked('d', '/after'), true);
});

test('removeDevice clears marks and its epoch without affecting another device', () => {
  const store = new DirectoryModificationStore();
  store.markPath('a', '/tmp/a');
  store.markPath('b', '/tmp/b');
  store.beginEpoch('a', 'epoch-a');
  store.removeDevice('a');
  assert.equal(store.version('a', '/tmp/a'), null);
  assert.equal(store.currentEpoch('a'), null);
  assert.equal(store.isMarked('b', '/tmp/b'), true);
});
