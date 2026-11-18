import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRcGate } from '../src/gate.mjs';

test('requires all delivery nodes and successful workflow evidence', () => {
  const nodes = ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build'].map(kind => ({ kind, state: 'SUCCEEDED' }));
  assert.equal(evaluateRcGate({ nodes, workflows: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }).passed, true);
  assert.equal(evaluateRcGate({ nodes: nodes.slice(0, -1), workflows: [] }).missingNodes[0], 'rc-build');
});
