import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const taskStates = new Set(['REQUIREMENT_APPROVED', 'TEST_CASES_APPROVED', 'IMPLEMENTING', 'LOCAL_VERIFYING', 'CI_VERIFYING', 'FIXING', 'RC_BUILDING', 'RC_READY', 'USER_ACCEPTING', 'RELEASE_APPROVED', 'RELEASE_TRIGGERED', 'RELEASED', 'BLOCKED_USER_DECISION', 'CANCELLED']);

export class OrchestratorStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, base_sha TEXT NOT NULL, state TEXT NOT NULL, requirement_hash TEXT NOT NULL, test_case_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, requirement_content TEXT, test_case_content TEXT);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, kind));
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, location TEXT NOT NULL, sha TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_runs (task_id TEXT NOT NULL, sha TEXT NOT NULL, name TEXT NOT NULL, run_id TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(task_id, run_id));
      CREATE TABLE IF NOT EXISTS retry_attempts (task_id TEXT NOT NULL, root_kind TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id, root_kind, attempt));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    if (!columns.has('requirement_content')) this.db.exec('ALTER TABLE tasks ADD COLUMN requirement_content TEXT');
    if (!columns.has('test_case_content')) this.db.exec('ALTER TABLE tasks ADD COLUMN test_case_content TEXT');
  }
  createTask(input) {
    const id = input.id ?? `RND-${randomUUID().slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    const task = { id, title: input.title, repository: input.repository, branch: input.branch, baseSha: input.baseSha, state: 'TEST_CASES_APPROVED', requirementHash: input.requirementHash, testCaseHash: input.testCaseHash, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO tasks (id,title,repository,branch,base_sha,state,requirement_hash,test_case_hash,created_at,updated_at,requirement_content,test_case_content) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(task.id, task.title, task.repository, task.branch, task.baseSha, task.state, task.requirementHash, task.testCaseHash, now, now, input.requirementContent ?? null, input.testCaseContent ?? null);
    this.event(id, 'TASK_CREATED', { ...task, approvalFrozen: true, requirementApprovedBy: input.approvedBy ?? null, testCasesApprovedBy: input.approvedBy ?? null, approvedAt: now });
    return task;
  }
  transition(id, state, data = {}) {
    if (!taskStates.has(state)) throw new Error('INVALID_TASK_STATE');
    const now = new Date().toISOString();
    if (this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(state, now, id).changes !== 1) throw new Error('TASK_NOT_FOUND');
    this.event(id, 'STATE_CHANGED', { state, ...data });
  }
  approveRelease(id, approvedBy, note = '') {
    const task = this.get(id);
    if (task.state !== 'RC_READY') throw new Error('RELEASE_APPROVAL_REQUIRES_RC_READY');
    if (!approvedBy) throw new Error('RELEASE_APPROVER_REQUIRED');
    this.transition(id, 'RELEASE_APPROVED', { approvedBy, note, approvedAt: new Date().toISOString() });
  }
  acquire(key, holder, ttlMs = 60000) {
    const now = new Date(); const expires = new Date(now.getTime() + ttlMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT * FROM locks WHERE key=?').get(key);
      if (current && new Date(current.expires_at) > now && current.holder !== holder) throw new Error('RESOURCE_BUSY');
      this.db.prepare('INSERT OR REPLACE INTO locks VALUES(?,?,?)').run(key, holder, expires);
      this.db.exec('COMMIT'); return { key, holder, expiresAt: expires };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  release(key, holder) { this.db.prepare('DELETE FROM locks WHERE key=? AND holder=?').run(key, holder); }
  event(taskId, type, data) { this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(randomUUID(), taskId, type, JSON.stringify(data), new Date().toISOString()); }
  plan(id, kinds) {
    this.get(id); const now = new Date().toISOString();
    const insert = this.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?)');
    for (const kind of kinds) insert.run(`${id}/${kind}`, id, kind, 'PENDING', '{}', now, now);
    this.event(id, 'PLAN_CREATED', { kinds }); return this.nodes(id);
  }
  node(id, kind, state, data = {}) {
    const now = new Date().toISOString();
    if (this.db.prepare('UPDATE nodes SET state=?,data=?,updated_at=? WHERE task_id=? AND kind=?').run(state, JSON.stringify(data), now, id, kind).changes !== 1) throw new Error('NODE_NOT_FOUND');
    this.event(id, 'NODE_CHANGED', { kind, state, ...data });
  }
  nodes(id) { return this.db.prepare('SELECT kind,state,data,updated_at FROM nodes WHERE task_id=? ORDER BY rowid').all(id).map(row => ({ kind: row.kind, state: row.state, data: JSON.parse(row.data), updatedAt: row.updated_at })); }
  artifact(id, kind, location, sha = null) { this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(randomUUID(), id, kind, location, sha, new Date().toISOString()); this.event(id, 'ARTIFACT_RECORDED', { kind, location, sha }); }
  artifacts(id) { return this.db.prepare('SELECT kind,location,sha,created_at FROM artifacts WHERE task_id=? ORDER BY created_at').all(id).map(row => ({ kind: row.kind, location: row.location, sha: row.sha, createdAt: row.created_at })); }
  workflows(id) { return this.db.prepare('SELECT sha,name,run_id,url,status,conclusion,recorded_at FROM workflow_runs WHERE task_id=? ORDER BY recorded_at').all(id).map(row => ({ sha: row.sha, name: row.name, runId: row.run_id, url: row.url, status: row.status, conclusion: row.conclusion, recordedAt: row.recorded_at })); }
  workflow(id, sha, run) { this.db.prepare('INSERT OR REPLACE INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)').run(id, sha, run.name, String(run.databaseId), run.url, run.status, run.conclusion ?? null, new Date().toISOString()); this.event(id, 'WORKFLOW_RECORDED', { sha, name: run.name, runId: run.databaseId, status: run.status, conclusion: run.conclusion }); }
  get(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    return { id: row.id, title: row.title, repository: row.repository, branch: row.branch, baseSha: row.base_sha, state: row.state, requirementHash: row.requirement_hash, testCaseHash: row.test_case_hash, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  approvedDocuments(id) {
    const row = this.db.prepare('SELECT requirement_content,test_case_content FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    if (row.requirement_content === null || row.test_case_content === null) throw new Error('APPROVED_DOCUMENT_CONTENT_MISSING');
    return { requirementContent: row.requirement_content, testCaseContent: row.test_case_content };
  }
  events(id) { return this.db.prepare('SELECT type,data,created_at FROM events WHERE task_id=? ORDER BY created_at').all(id).map(row => ({ type: row.type, data: JSON.parse(row.data), createdAt: row.created_at })); }
  deliverySha(id) {
    const row = this.db.prepare("SELECT data FROM events WHERE task_id=? AND type='GIT_VERIFIED' ORDER BY created_at DESC LIMIT 1").get(id);
    if (!row) throw new Error('DELIVERY_SHA_NOT_VERIFIED');
    const sha = JSON.parse(row.data).sha;
    if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) throw new Error('DELIVERY_SHA_INVALID');
    return sha;
  }
  requestRc(id, version) {
    this.get(id);
    if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) throw new Error('INVALID_RC_VERSION');
    this.event(id, 'RC_REQUESTED', { version, requestedAt: new Date().toISOString() });
    return { version };
  }
  rcRequest(id) {
    const row = this.db.prepare("SELECT data FROM events WHERE task_id=? AND type='RC_REQUESTED' ORDER BY created_at DESC LIMIT 1").get(id);
    if (!row) throw new Error('RC_VERSION_NOT_REQUESTED');
    return JSON.parse(row.data);
  }
  retryCount(id, rootKind) { return this.db.prepare('SELECT COUNT(*) AS count FROM retry_attempts WHERE task_id=? AND root_kind=?').get(id, rootKind).count; }
  retry(id, rootKind, kinds, maxAttempts = 3) {
    const task = this.get(id);
    if (task.state !== 'FIXING') throw new Error('RETRY_REQUIRES_FIXING_STATE');
    if (!Array.isArray(kinds) || !kinds.includes(rootKind)) throw new Error('RETRY_PLAN_INVALID');
    const previous = this.retryCount(id, rootKind);
    if (previous >= maxAttempts) {
      this.transition(id, 'BLOCKED_USER_DECISION', { reason: 'RETRY_LIMIT_REACHED', rootKind, attempts: previous });
      return { allowed: false, attempts: previous, maxAttempts };
    }
    const attempt = previous + 1; const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reset = this.db.prepare("UPDATE nodes SET state='PENDING',data='{}',updated_at=? WHERE task_id=? AND kind=?");
      for (const kind of kinds) if (reset.run(now, id, kind).changes !== 1) throw new Error('RETRY_NODE_NOT_FOUND');
      this.db.prepare('INSERT INTO retry_attempts VALUES(?,?,?,?)').run(id, rootKind, attempt, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.transition(id, 'IMPLEMENTING', { retry: { rootKind, attempt, maxAttempts, reset: kinds } });
    return { allowed: true, attempts: attempt, maxAttempts, reset: kinds };
  }
  recover() {
    const now = new Date().toISOString();
    const interrupted = this.db.prepare("SELECT DISTINCT task_id FROM nodes WHERE state='RUNNING'").all().map(row => row.task_id);
    const active = this.db.prepare("SELECT id FROM tasks WHERE state IN ('IMPLEMENTING','LOCAL_VERIFYING','CI_VERIFYING','FIXING','RC_BUILDING')").all().map(row => row.id);
    const taskIds = [...new Set([...interrupted, ...active])];
    const nodes = this.db.prepare("UPDATE nodes SET state='UNKNOWN',updated_at=? WHERE state='RUNNING'").run(now).changes;
    const update = this.db.prepare("UPDATE tasks SET state='BLOCKED_USER_DECISION',updated_at=? WHERE id=? AND state NOT IN ('RC_READY','RELEASE_APPROVED','RELEASE_TRIGGERED','RELEASED','CANCELLED','BLOCKED_USER_DECISION')");
    let tasks = 0;
    for (const id of taskIds) {
      tasks += update.run(now, id).changes;
      this.event(id, 'RECOVERY_REQUIRES_RECONCILIATION', { interrupted: interrupted.includes(id), recoveredAt: now });
    }
    return { tasks, nodes };
  }
  list() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(row => ({ id: row.id, title: row.title, repository: row.repository, branch: row.branch, baseSha: row.base_sha, state: row.state, updatedAt: row.updated_at })); }
  close() { this.db.close(); }
}
