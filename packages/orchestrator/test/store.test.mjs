import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OrchestratorStore } from '../src/store.mjs';
import { sha256File } from '../src/project.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('stores approved documents outside SQLite and restores them after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingxi-orchestrator-private-docs-'));
  const database = join(directory, 'orchestrator.sqlite');
  const requirementContent = '# Requirement';
  const testCaseContent = '# Test cases';
  const requirementHash = createHash('sha256').update(requirementContent).digest('hex');
  const testCaseHash = createHash('sha256').update(testCaseContent).digest('hex');
  let store = new OrchestratorStore(database);
  const task = store.createTask({ id: 'RND-DOC-CONTENT', title: 'Docs', repository: 'owner/repo', branch: 'feat/docs-content', baseSha: 'a'.repeat(40), requirementHash, testCaseHash, requirementContent, testCaseContent });
  assert.deepEqual(store.approvedDocuments(task.id), { requirementContent, testCaseContent });
  assert.equal(Object.hasOwn(store.get(task.id), 'requirementContent'), false);
  assert.equal(Object.hasOwn(store.list()[0], 'testCaseContent'), false);
  const columns = store.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
  assert.equal(columns.includes('requirement_content'), false);
  assert.equal(columns.includes('test_case_content'), false);
  store.close();
  assert.equal(readFileSync(database).includes(requirementContent), false);
  assert.equal(readFileSync(database).includes(testCaseContent), false);
  store = new OrchestratorStore(database);
  assert.deepEqual(store.approvedDocuments(task.id), { requirementContent, testCaseContent });
  store.close();
});

test('migrates approved document bodies out of legacy SQLite databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingxi-orchestrator-legacy-docs-'));
  const database = join(directory, 'orchestrator.sqlite');
  const requirementContent = 'legacy approved requirement';
  const testCaseContent = 'legacy approved test cases';
  const requirementHash = createHash('sha256').update(requirementContent).digest('hex');
  const testCaseHash = createHash('sha256').update(testCaseContent).digest('hex');
  const legacy = new DatabaseSync(database);
  legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,repository TEXT NOT NULL,branch TEXT NOT NULL UNIQUE,base_sha TEXT NOT NULL,state TEXT NOT NULL,requirement_hash TEXT NOT NULL,test_case_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,requirement_content TEXT,test_case_content TEXT)');
  legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('RND-LEGACY', 'Legacy', 'owner/repo', 'feat/legacy', 'a'.repeat(40), 'TEST_CASES_APPROVED', requirementHash, testCaseHash, new Date().toISOString(), new Date().toISOString(), requirementContent, testCaseContent);
  legacy.close();
  const store = new OrchestratorStore(database);
  assert.deepEqual(store.approvedDocuments('RND-LEGACY'), { requirementContent, testCaseContent });
  const columns = store.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
  assert.equal(columns.includes('requirement_content'), false);
  assert.equal(columns.includes('test_case_content'), false);
  store.close();
  assert.equal(readFileSync(database).includes(requirementContent), false);
  assert.equal(readFileSync(database).includes(testCaseContent), false);
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

test('keeps idle active tasks resumable after a controller restart', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-RESUME', title: 'Resume', repository: 'owner/repo', branch: 'feat/resume', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc' });
  store.transition(task.id, 'IMPLEMENTING');
  assert.equal(store.recover().tasks, 0);
  assert.equal(store.get(task.id).state, 'IMPLEMENTING');
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

test('persists quota wait and wakes exactly when its retry time arrives', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-QUOTA', title: 'Quota', repository: 'owner/repo', branch: 'feat/quota', baseSha: 'abc', requirementHash: 'r', testCaseHash: 't' });
  store.plan(task.id, ['develop', 'ci']);
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  store.waitForQuota(task.id, 'develop', { retryAt, evidence: { code: 'usage_limit_reached' } });
  assert.equal(store.get(task.id).state, 'WAITING_QUOTA');
  assert.equal(store.nodes(task.id)[0].state, 'WAITING_QUOTA');
  assert.deepEqual(store.wakeDueQuotaTasks(Date.now()), []);
  assert.deepEqual(store.wakeDueQuotaTasks(Date.parse(retryAt)), [task.id]);
  assert.equal(store.get(task.id).state, 'IMPLEMENTING');
  assert.equal(store.nodes(task.id)[0].state, 'PENDING');
  assert.ok(store.events(task.id).some(event => event.type === 'QUOTA_WAIT_ENDED'));
  store.close();
});

test('blocks a task after its configured maximum total quota wait', () => {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-QUOTA-LIMIT', title: 'Quota limit', repository: 'owner/repo', branch: 'feat/quota-limit', baseSha: 'abc', requirementHash: 'r', testCaseHash: 't' });
  store.plan(task.id, ['develop']);
  store.waitForQuota(task.id, 'develop', { retryAt: new Date(Date.now() + 60_000).toISOString(), evidence: { code: 'quota' } });
  store.db.prepare("UPDATE events SET created_at=? WHERE task_id=? AND type='QUOTA_WAIT_STARTED'").run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), task.id);
  const result = store.waitForQuota(task.id, 'develop', { retryAt: new Date(Date.now() + 60_000).toISOString(), evidence: { code: 'quota' }, maxTotalWaitMs: 24 * 60 * 60_000 });
  assert.equal(result.state, 'BLOCKED_USER_DECISION');
  assert.equal(store.get(task.id).state, 'BLOCKED_USER_DECISION');
  assert.ok(store.events(task.id).some(event => event.type === 'QUOTA_WAIT_LIMIT_REACHED'));
  store.close();
});
