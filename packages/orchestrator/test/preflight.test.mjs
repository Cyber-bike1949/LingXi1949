import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPlan, safeSummary } from '../src/preflight.mjs';

test('preflight enumerates every configured executor and required workflow', () => {
  const remote = id => ({ session: id, lingxiCli: '/tmp/cli.mjs' });
  const plan = preflightPlan({ project: { repository: 'owner/repo' }, runtime: { remotes: { development: remote('dev'), test: remote('test') }, agent: { target: 'remote', executable: 'codex' }, tester: { target: 'local', executable: 'claude' }, workflows: { required: ['CI'], e2eRequired: ['UI'], rc: { required: ['RC'] } } } });
  assert.deepEqual(plan.workflows, ['CI', 'UI', 'RC']);
  assert.equal(plan.remotes.length, 2);
  assert.equal(plan.agents[1].target, 'local');
});

test('preflight summaries bound command output', () => {
  assert.equal(safeSummary({ exitCode: 0, stdout: 'x'.repeat(600), stderr: '' }).stdout.length, 500);
});
