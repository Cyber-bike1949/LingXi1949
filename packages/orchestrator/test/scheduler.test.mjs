import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedBy, nextNodes, retryKinds } from '../src/scheduler.mjs';

test('releases only nodes whose dependency nodes succeeded', () => {
  const nodes = [{ kind: 'prepare-worktree', state: 'SUCCEEDED' }, { kind: 'develop', state: 'PENDING' }, { kind: 'local-verify', state: 'PENDING' }];
  assert.deepEqual(nextNodes(nodes).map(node => node.kind), ['develop']);
  assert.deepEqual(blockedBy(nodes).find(node => node.kind === 'local-verify').waitingFor, ['test']);
});

test('resets a failed development branch and all of its descendants', () => {
  const nodes = ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build', 'rc'].map(kind => ({ kind, state: 'SUCCEEDED' }));
  assert.deepEqual(retryKinds('develop', nodes), ['develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build', 'rc']);
});
