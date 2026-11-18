import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorStore } from '../src/store.mjs';
import { sha256File } from '../src/project.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('persists an approved task, transitions it, and protects a resource lease', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-042', title: 'Status', repository: 'owner/repo', branch: 'feat/ai-RND-042', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc', approvedBy: 'dog' });
  assert.equal(task.state, 'TEST_CASES_APPROVED');
  store.transition(task.id, 'IMPLEMENTING');
  assert.equal(store.list()[0].state, 'IMPLEMENTING');
  assert.equal(store.get(task.id).requirementHash, 'req');
  store.event(task.id, 'GIT_VERIFIED', { sha: 'a'.repeat(40) });
  assert.equal(store.deliverySha(task.id), 'a'.repeat(40));
  assert.ok(store.events(task.id).some(event => event.type === 'TASK_CREATED'));
  assert.equal(store.events(task.id).find(event => event.type === 'TASK_CREATED').data.requirementApprovedBy, 'dog');
  assert.ok(store.events(task.id).some(event => event.type === 'STATE_CHANGED'));
  assert.equal(store.plan(task.id, ['develop', 'ci']).length, 2);
  store.node(task.id, 'develop', 'SUCCEEDED', { commitSha: 'def' });
  store.artifact(task.id, 'report', 'reports/RND-042.json', 'hash');
  assert.equal(store.artifacts(task.id)[0].kind, 'report');
  store.acquire('linux:/worktrees/RND-042', task.id);
  assert.throws(() => store.acquire('linux:/worktrees/RND-042', 'RND-043'), /RESOURCE_BUSY/);
  store.close();
});

test('hashes an approved document from its bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingxi-orchestrator-'));
  const file = join(directory, 'requirement.md'); writeFileSync(file, 'approved');
  assert.match(sha256File(file), /^[0-9a-f]{64}$/);
});

test('stores approved document text for agents without exposing it in ordinary task records', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-DOC-CONTENT', title: 'Docs', repository: 'owner/repo', branch: 'feat/docs-content', baseSha: 'a'.repeat(40), requirementHash: 'req', testCaseHash: 'tc', requirementContent: '# Requirement', testCaseContent: '# Test cases' });
  assert.deepEqual(store.approvedDocuments(task.id), { requirementContent: '# Requirement', testCaseContent: '# Test cases' });
  assert.equal(Object.hasOwn(store.get(task.id), 'requirementContent'), false);
  assert.equal(Object.hasOwn(store.list()[0], 'testCaseContent'), false);
  store.close();
});

test('requires an RC-ready task and an approver before release approval', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-043', title: 'Release', repository: 'owner/repo', branch: 'feat/ai-RND-043', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc' });
  assert.throws(() => store.approveRelease(task.id, 'dog'), /RC_READY/);
  store.transition(task.id, 'RC_READY');
  store.approveRelease(task.id, 'dog');
  assert.equal(store.get(task.id).state, 'RELEASE_APPROVED');
  store.close();
});

test('stores only a syntactically valid requested RC version', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-RC', title: 'RC', repository: 'owner/repo', branch: 'feat/rc', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc' });
  assert.throws(() => store.requestRc(task.id, '1.0.0'), /INVALID_RC_VERSION/);
  assert.deepEqual(store.requestRc(task.id, '1.0.0-rc.1'), { version: '1.0.0-rc.1' });
  assert.equal(store.rcRequest(task.id).version, '1.0.0-rc.1');
  store.close();
});

test('marks in-flight nodes unknown during recovery', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-044', title: 'Recover', repository: 'owner/repo', branch: 'feat/ai-RND-044', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc' });
  store.plan(task.id, ['prepare-worktree']); store.node(task.id, 'prepare-worktree', 'RUNNING');
  assert.equal(store.recover().nodes, 1);
  assert.equal(store.nodes(task.id)[0].state, 'UNKNOWN');
  assert.equal(store.get(task.id).state, 'BLOCKED_USER_DECISION');
  assert.ok(store.events(task.id).some(event => event.type === 'RECOVERY_REQUIRES_RECONCILIATION'));
  store.close();
});

test('limits repair retries and resets downstream nodes atomically', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-RETRY', title: 'Retry', repository: 'owner/repo', branch: 'feat/retry', baseSha: 'base', requirementHash: 'r', testCaseHash: 't' });
  store.plan(task.id, ['develop', 'ci']); store.node(task.id, 'develop', 'FAILED', {}); store.node(task.id, 'ci', 'FAILED', {}); store.transition(task.id, 'FIXING');
  assert.deepEqual(store.retry(task.id, 'develop', ['develop', 'ci']), { allowed: true, attempts: 1, maxAttempts: 3, reset: ['develop', 'ci'] });
  assert.deepEqual(store.nodes(task.id).map(node => node.state), ['PENDING', 'PENDING']);
  store.transition(task.id, 'FIXING'); store.retry(task.id, 'develop', ['develop', 'ci']); store.transition(task.id, 'FIXING'); store.retry(task.id, 'develop', ['develop', 'ci']); store.transition(task.id, 'FIXING');
  assert.equal(store.retry(task.id, 'develop', ['develop', 'ci']).allowed, false);
  assert.equal(store.get(task.id).state, 'BLOCKED_USER_DECISION');
  store.close();
});
