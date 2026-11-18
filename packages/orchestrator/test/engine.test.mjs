import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAction } from '../src/engine.mjs';

test('selects the first dependency-ready node', () => {
  assert.deepEqual(nextAction([{ kind: 'prepare-worktree', state: 'PENDING' }]), { kind: 'prepare-worktree' });
  assert.equal(nextAction([{ kind: 'prepare-worktree', state: 'RUNNING' }]), null);
});
