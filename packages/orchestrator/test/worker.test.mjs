import test from 'node:test';
import assert from 'node:assert/strict';
import { runnableTasks } from '../src/worker.mjs';

test('worker never selects terminal, approval, or blocked tasks', () => {
  const tasks = ['TEST_CASES_APPROVED', 'FIXING', 'RC_READY', 'RELEASE_APPROVED', 'RELEASED', 'BLOCKED_USER_DECISION'].map((state, index) => ({ id: String(index), state }));
  assert.deepEqual(runnableTasks(tasks).map(task => task.state), ['TEST_CASES_APPROVED', 'FIXING']);
});
