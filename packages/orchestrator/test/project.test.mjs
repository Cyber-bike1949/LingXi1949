import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { joinRemotePath, runtimeConfig, taskPrompt } from '../src/project.mjs';

const remote = suffix => ({ lingxiCli: '/tmp/lingxi-cli.mjs', session: `session-${suffix}`, worktreeRoot: `/worktrees/${suffix}` });
const agent = { executable: 'codex', args: ['exec', '-'], target: 'local' };

test('uses independent development and test remotes when configured', () => {
  const config = runtimeConfig({ runtime: { remotes: { development: remote('dev'), test: remote('test') }, agent, tester: { ...agent, executable: 'claude' }, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } });
  assert.equal(config.remotes.development.session, 'session-dev');
  assert.equal(config.remotes.test.session, 'session-test');
  assert.equal(config.tester.executable, 'claude');
});

test('keeps single-device projects compatible with a separate test worktree', () => {
  const config = runtimeConfig({ runtime: { remote: remote('shared'), agent, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } });
  assert.equal(config.remotes.development.session, config.remotes.test.session);
  assert.equal(config.remotes.test.worktreeRoot, '/worktrees/shared/test');
  assert.equal(config.tester.executable, 'codex');
});

test('rejects an explicit development/test worktree collision on one device', () => {
  assert.throws(() => runtimeConfig({ runtime: { remotes: { development: remote('same'), test: remote('same') }, agent, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } }), /WORKTREE_ROOT_COLLISION/);
});

test('requires Codex to run on the controller', () => {
  const config = { runtime: { remote: remote('shared'), agent: { ...agent, target: 'remote' }, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } };
  assert.throws(() => runtimeConfig(config), /CODEX_MUST_RUN_ON_CONTROLLER/);
});

test('joins Windows worktree paths using the remote shell type', () => {
  const windowsRemote = { worktreeRoot: 'D:\\project\\_worktrees', shellKind: 'cmd' };
  assert.equal(joinRemotePath(windowsRemote, 'task-1'), 'D:\\project\\_worktrees\\task-1');
});

test('preserves a project-scoped local Codex MCP configuration', () => {
  const mcp = { name: 'lingxi-demo', command: '/usr/bin/node', serverArgs: ['cli.mjs', 'serve'] };
  const config = runtimeConfig({ runtime: { remote: remote('shared'), agent: { ...agent, target: 'local', mcp }, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } });
  assert.equal(config.agent.target, 'local');
  assert.deepEqual(config.agent.mcp, mcp);
  assert.equal(config.tester.mcp.name, 'lingxi-demo');
});

test('includes the exact approved documents in the agent prompt and verifies their hashes', () => {
  const requirementContent = '# Approved requirement';
  const testCaseContent = '# Approved test cases';
  const hash = content => createHash('sha256').update(content).digest('hex');
  const task = { id: 'RND-DOCS', title: 'Docs', repository: 'owner/repo', branch: 'feat/docs', baseSha: 'a'.repeat(40), requirementHash: hash(requirementContent), testCaseHash: hash(testCaseContent) };
  const prompt = taskPrompt(task, 'developer', { commands: ['npm test'] }, { requirementContent, testCaseContent });
  assert.equal(prompt.approvedDocuments.requirement, requirementContent);
  assert.equal(prompt.approvedDocuments.testCases, testCaseContent);
  assert.throws(() => taskPrompt(task, 'developer', { commands: [] }, { requirementContent: 'altered', testCaseContent }), /APPROVED_REQUIREMENT_HASH_MISMATCH/);
});

test('requires explicit persistent Codex resume arguments and rejects ephemeral sessions', () => { const base = { runtime: { remote: remote('resume'), agent: { ...agent, resumeNativeSession: true }, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } } } }; assert.throws(() => runtimeConfig(base), /AGENT_RESUME_ARGS_REQUIRED/); assert.throws(() => runtimeConfig({ runtime: { ...base.runtime, agent: { ...agent, args: ['exec', '--ephemeral', '-'], resumeNativeSession: true, resumeArgs: ['exec', 'resume', '{sessionId}', '-'] } } }), /INCOMPATIBLE_WITH_EPHEMERAL/); const config = runtimeConfig({ runtime: { ...base.runtime, agent: { ...agent, resumeNativeSession: true, resumeArgs: ['exec', 'resume', '{sessionId}', '-'] } } }); assert.equal(config.agent.resumeNativeSession, true); });

test('refuses an enabled sandbox until an enforcing sandbox provider is implemented', () => { assert.throws(() => runtimeConfig({ runtime: { remote: remote('sandbox'), agent, workflows: { required: ['CI'], rc: { workflow: 'rc.yml', required: ['RC'] } }, sandbox: { enabled: true, provider: 'docker' } } }), /SANDBOX_NOT_IMPLEMENTED/); });
