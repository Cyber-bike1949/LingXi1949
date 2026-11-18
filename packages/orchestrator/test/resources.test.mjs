import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeLeaseKey } from '../src/resources.mjs';

test('uses an explicit device resource id when sessions share a device', () => {
  assert.equal(worktreeLeaseKey({ session: 'session-1', resourceId: 'linux-dev-01' }, '/worktrees/RND-1'), 'worktree:linux-dev-01:/worktrees/RND-1');
  assert.equal(worktreeLeaseKey({ session: 'session-1' }, '/worktrees/RND-1'), 'worktree:session-1:/worktrees/RND-1');
});
