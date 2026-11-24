import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ApprovedDocumentStore } from './approvedDocuments.mjs';

const taskStates = new Set(['REQUIREMENT_APPROVED', 'TEST_CASES_APPROVED', 'WAITING_QUOTA', 'IMPLEMENTING', 'LOCAL_VERIFYING', 'CI_VERIFYING', 'FIXING', 'RC_BUILDING', 'RC_READY', 'USER_ACCEPTING', 'RELEASE_APPROVED', 'RELEASE_TRIGGERED', 'RELEASED', 'BLOCKED_USER_DECISION', 'CANCELLED']);

export class OrchestratorStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.approvedDocumentStore = new ApprovedDocumentStore(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, base_sha TEXT NOT NULL, state TEXT NOT NULL, requirement_hash TEXT NOT NULL, test_case_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, kind));
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, location TEXT NOT NULL, sha TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_runs (task_id TEXT NOT NULL, sha TEXT NOT NULL, name TEXT NOT NULL, run_id TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(task_id, run_id));
      CREATE TABLE IF NOT EXISTS retry_attempts (task_id TEXT NOT NULL, root_kind TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id, root_kind, attempt));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    const legacyRequirement = columns.has('requirement_content');
    const legacyTestCases = columns.has('test_case_content');
    if (legacyRequirement || legacyTestCases) {
      const requirementColumn = legacyRequirement ? 'requirement_content' : 'NULL AS requirement_content';
      const testCasesColumn = legacyTestCases ? 'test_case_content' : 'NULL AS test_case_content';
      const rows = this.db.prepare(`SELECT id,requirement_hash,test_case_hash,${requirementColumn},${testCasesColumn} FROM tasks`).all();
      for (const row of rows) {
        if (row.requirement_content === null && row.test_case_content === null) continue;
        this.approvedDocumentStore.writePair(row.id, row.requirement_content, row.test_case_content, row.requirement_hash, row.test_case_hash, true);
        const cleared = [];
        if (legacyRequirement) cleared.push('requirement_content=NULL');
        if (legacyTestCases) cleared.push('test_case_content=NULL');
        this.db.prepare(`UPDATE tasks SET ${cleared.join(',')} WHERE id=?`).run(row.id);
      }
      if (legacyRequirement) this.db.exec('ALTER TABLE tasks DROP COLUMN requirement_content');
      if (legacyTestCases) this.db.exec('ALTER TABLE tasks DROP COLUMN test_case_content');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    }
  }
  createTask(input) {
    const id = input.id ?? `RND-${randomUUID().slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    const task = { id, title: input.title, repository: input.repository, branch: input.branch, baseSha: input.baseSha, state: 'TEST_CASES_APPROVED', requirementHash: input.requirementHash, testCaseHash: input.testCaseHash, createdAt: now, updatedAt: now };
    this.approvedDocumentStore.writePair(id, input.requirementContent, input.testCaseContent, task.requirementHash, task.testCaseHash);
    this.db.prepare('INSERT INTO tasks (id,title,repository,branch,base_sha,state,requirement_hash,test_case_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(task.id, task.title, task.repository, task.branch, task.baseSha, task.state, task.requirementHash, task.testCaseHash, now, now);
    this.event(id, 'TASK_CREATED', { ...task, approvalFrozen: true, requirementApprovedBy: input.approvedBy ?? null, testCasesApprovedBy: input.approvedBy ?? null, approvedAt: now });
    return task;
  }
  transition(id, state, data = {}) {
    if (!taskStates.has(state)) throw new Error('INVALID_TASK_STATE');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(state, now, id).changes;
      if (changed !== 1) throw new Error('TASK_NOT_FOUND');
      this.event(id, 'STATE_CHANGED', { state, ...data });
      if (['IMPLEMENTING', 'WAITING_QUOTA', 'BLOCKED_USER_DECISION', 'RC_READY', 'RELEASED'].includes(state)) {
        const task = this.get(id);
        this.enqueueNotification({ dedupeKey: `${id}:${state}:${now}`, taskId: id, eventType: state, payload: { taskId: id, title: task.title, state, branch: task.branch, reason: data.reason ?? null, retryAt: data.retryAt ?? null, occurredAt: now } });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    const row = this.db.prepare('SELECT requirement_hash,test_case_hash FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    return {
      requirementContent: this.approvedDocumentStore.read(id, 'requirement', row.requirement_hash),
      testCaseContent: this.approvedDocumentStore.read(id, 'test-cases', row.test_case_hash)
    };
  }
  events(id) { return this.db.prepare('SELECT id,type,data,created_at FROM events WHERE task_id=? ORDER BY created_at,rowid').all(id).map(row => ({ id: row.id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at })); }
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
  enqueueNotification({ dedupeKey, taskId, eventType, payload }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO notification_outbox (id,dedupe_key,task_id,event_type,payload,status,attempts,next_attempt_at,last_error,created_at,sent_at) VALUES(?,?,?,?,?,'PENDING',0,?,NULL,?,NULL)").run(id, dedupeKey, taskId, eventType, JSON.stringify(payload), now, now);
    return this.db.prepare('SELECT id,dedupe_key,task_id,event_type,payload,status,attempts,next_attempt_at,last_error,created_at,sent_at FROM notification_outbox WHERE dedupe_key=?').get(dedupeKey);
  }
  pendingNotifications(now = Date.now(), limit = 50) {
    const at = new Date(now).toISOString();
    return this.db.prepare("SELECT * FROM notification_outbox WHERE status='PENDING' AND next_attempt_at<=? ORDER BY created_at LIMIT ?").all(at, limit).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  markNotificationSent(id, sentAt = new Date().toISOString()) {
    this.db.prepare("UPDATE notification_outbox SET status='SENT',sent_at=?,last_error=NULL WHERE id=?").run(sentAt, id);
  }
  markNotificationFailed(id, error, retryAt, maxAttempts = 8) {
    const current = this.db.prepare('SELECT attempts FROM notification_outbox WHERE id=?').get(id);
    if (!current) throw new Error('NOTIFICATION_NOT_FOUND');
    const attempts = current.attempts + 1;
    this.db.prepare("UPDATE notification_outbox SET attempts=?,status=?,next_attempt_at=?,last_error=? WHERE id=?").run(attempts, attempts >= maxAttempts ? 'DEAD' : 'PENDING', retryAt, String(error).slice(0, 1000), id);
    return { attempts, dead: attempts >= maxAttempts, retryAt };
  }
  notifications(taskId) {
    return this.db.prepare('SELECT id,event_type,status,attempts,next_attempt_at,last_error,created_at,sent_at FROM notification_outbox WHERE task_id=? ORDER BY created_at').all(taskId);
  }
  waitForQuota(id, kind, { retryAt, evidence, maxTotalWaitMs = 24 * 60 * 60_000 }) {
    if (!Number.isFinite(Date.parse(retryAt))) throw new Error('QUOTA_RETRY_TIME_INVALID');
    this.get(id);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const firstWait = this.db.prepare("SELECT created_at FROM events WHERE task_id=? AND type='QUOTA_WAIT_STARTED' ORDER BY created_at LIMIT 1").get(id);
      const exceeded = firstWait && Date.now() - Date.parse(firstWait.created_at) >= maxTotalWaitMs;
      const state = exceeded ? 'BLOCKED_USER_DECISION' : 'WAITING_QUOTA';
      const nodeState = exceeded ? 'FAILED' : 'WAITING_QUOTA';
      const nodeData = exceeded
        ? { retryAt, quotaEvidence: evidence, reason: 'QUOTA_WAIT_LIMIT_REACHED' }
        : { retryAt, quotaEvidence: evidence };
      const nodeChanged = this.db.prepare('UPDATE nodes SET state=?,data=?,updated_at=? WHERE task_id=? AND kind=?').run(nodeState, JSON.stringify(nodeData), now, id, kind).changes;
      if (nodeChanged !== 1) throw new Error('NODE_NOT_FOUND');
      this.event(id, 'NODE_CHANGED', { kind, state: nodeState, ...nodeData });
      const taskChanged = this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(state, now, id).changes;
      if (taskChanged !== 1) throw new Error('TASK_NOT_FOUND');
      const transitionData = exceeded
        ? { reason: 'QUOTA_WAIT_LIMIT_REACHED', kind, retryAt, quotaEvidence: evidence }
        : { kind, retryAt, quotaEvidence: evidence };
      this.event(id, 'STATE_CHANGED', { state, ...transitionData });
      const task = this.get(id);
      this.enqueueNotification({ dedupeKey: `${id}:${state}:${now}`, taskId: id, eventType: state, payload: { taskId: id, title: task.title, state, branch: task.branch, reason: transitionData.reason ?? null, retryAt, occurredAt: now } });
      if (exceeded) {
        this.event(id, 'QUOTA_WAIT_LIMIT_REACHED', { kind, maxTotalWaitMs, firstWaitAt: firstWait.created_at });
      } else {
        this.event(id, 'QUOTA_WAIT_STARTED', { kind, retryAt, quotaEvidence: evidence });
      }
      this.db.exec('COMMIT');
      return exceeded
        ? { id, kind, state, reason: 'QUOTA_WAIT_LIMIT_REACHED' }
        : { id, kind, state, retryAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  wakeDueQuotaTasks(now = Date.now()) {
    const tasks = this.db.prepare("SELECT id FROM tasks WHERE state='WAITING_QUOTA'").all();
    const awakened = [];
    for (const { id } of tasks) {
      const row = this.db.prepare("SELECT data FROM events WHERE task_id=? AND type='QUOTA_WAIT_STARTED' ORDER BY created_at DESC LIMIT 1").get(id);
      if (!row) continue;
      const wait = JSON.parse(row.data);
      if (Date.parse(wait.retryAt) > now) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const changed = this.db.prepare("UPDATE tasks SET state='IMPLEMENTING',updated_at=? WHERE id=? AND state='WAITING_QUOTA'").run(new Date(now).toISOString(), id).changes;
        if (changed) {
          this.db.prepare("UPDATE nodes SET state='PENDING',data='{}',updated_at=? WHERE task_id=? AND kind=? AND state='WAITING_QUOTA'").run(new Date(now).toISOString(), id, wait.kind);
          this.db.exec('COMMIT');
          this.event(id, 'QUOTA_WAIT_ENDED', { kind: wait.kind, retryAt: wait.retryAt, awakenedAt: new Date(now).toISOString() });
          awakened.push(id);
        } else this.db.exec('ROLLBACK');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return awakened;
  }
  recover() {
    const now = new Date().toISOString();
    const safeToResume = new Set(['git-verify', 'local-verify', 'ci', 'rc']);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const interrupted = this.db.prepare("SELECT task_id,kind,data FROM nodes WHERE state='RUNNING' ORDER BY task_id,rowid").all();
      const byTask = new Map();
      let unknownNodes = 0;
      for (const node of interrupted) {
        const recovered = safeToResume.has(node.kind);
        const data = { ...JSON.parse(node.data), recoveredAt: now, recoveryAction: recovered ? 'safe-retry' : 'manual-reconciliation' };
        const state = recovered ? 'PENDING' : 'UNKNOWN';
        this.db.prepare('UPDATE nodes SET state=?,data=?,updated_at=? WHERE task_id=? AND kind=? AND state=?').run(state, JSON.stringify(data), now, node.task_id, node.kind, 'RUNNING');
        this.event(node.task_id, 'NODE_CHANGED', { kind: node.kind, state, recoveredAt: now, recoveryAction: data.recoveryAction });
        if (!recovered) unknownNodes += 1;
        const kinds = byTask.get(node.task_id) ?? { resumable: [], unknown: [] };
        kinds[recovered ? 'resumable' : 'unknown'].push(node.kind);
        byTask.set(node.task_id, kinds);
      }
      let blockedTasks = 0;
      let resumedTasks = 0;
      const updateBlocked = this.db.prepare("UPDATE tasks SET state='BLOCKED_USER_DECISION',updated_at=? WHERE id=? AND state NOT IN ('RC_READY','RELEASE_APPROVED','RELEASE_TRIGGERED','RELEASED','CANCELLED','BLOCKED_USER_DECISION')");
      for (const [id, kinds] of byTask) {
        if (kinds.unknown.length) {
          const changed = updateBlocked.run(now, id).changes;
          blockedTasks += changed;
          const task = this.get(id);
          this.event(id, 'RECOVERY_REQUIRES_RECONCILIATION', { interruptedKinds: [...kinds.resumable, ...kinds.unknown], unknownKinds: kinds.unknown, recoveredAt: now, state: changed ? 'BLOCKED_USER_DECISION' : task.state });
          if (changed) {
            this.event(id, 'STATE_CHANGED', { state: 'BLOCKED_USER_DECISION', reason: 'INTERRUPTED_STAGE_REQUIRES_RECONCILIATION', recoveredAt: now });
            this.enqueueNotification({
              dedupeKey: `${id}:RECOVERY_REQUIRES_RECONCILIATION:${now}`,
              taskId: id,
              eventType: 'BLOCKED_USER_DECISION',
              payload: { taskId: id, title: task.title, state: 'BLOCKED_USER_DECISION', branch: task.branch, reason: 'INTERRUPTED_STAGE_REQUIRES_RECONCILIATION', occurredAt: now }
            });
          }
        } else {
          resumedTasks += 1;
          this.event(id, 'RECOVERY_AUTO_RESUMED', { kinds: kinds.resumable, recoveredAt: now, strategy: 'repeat-read-only-or-verification-stage' });
        }
      }
      this.db.exec('COMMIT');
      return { tasks: blockedTasks, nodes: interrupted.length, interruptedNodes: interrupted.length, unknownNodes, blockedTasks, resumedTasks, taskIds: [...byTask.keys()] };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(row => ({ id: row.id, title: row.title, repository: row.repository, branch: row.branch, baseSha: row.base_sha, state: row.state, updatedAt: row.updated_at })); }
  close() { this.db.close(); }
}
