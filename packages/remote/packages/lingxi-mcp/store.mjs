import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class TaskStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.snapshotPath = filename === ':memory:' ? null : join(dirname(filename), 'tasks.json');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_version TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
        stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '', result TEXT,
        UNIQUE(scope, request_id));
      CREATE TABLE IF NOT EXISTS bindings (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_scope ON tasks(scope, started_at);`);
  }
  bind(scope, binding) {
    this.db.prepare('INSERT INTO bindings VALUES (?, ?, ?)').run(binding.sessionId, scope, JSON.stringify(binding));
  }
  recover(scope) {
    this.db.prepare("UPDATE tasks SET status='UNKNOWN', updated_at=? WHERE scope=? AND status IN ('QUEUED','RUNNING')").run(new Date().toISOString(), scope);
    this.snapshot();
  }
  begin(scope, binding, input) {
    const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    const existing = this.db.prepare('SELECT * FROM tasks WHERE scope=? AND request_id=?').get(scope, input.requestId);
    if (existing) {
      if (existing.input_hash !== hash) throw new Error('REQUEST_ID_CONFLICT');
      return { fresh: false, task: this.decode(existing) };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tasks(task_id,scope,request_id,input_hash,device_id,session_id,binding_version,action,target,started_at,updated_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'QUEUED')`).run(id, scope, input.requestId, hash, binding.deviceId, binding.sessionId, binding.bindingVersion, input.action, input.path ?? input.command ?? '', now, now);
    return { fresh: true, task: this.get(scope, id) };
  }
  running(id) { this.db.prepare("UPDATE tasks SET status='RUNNING',updated_at=? WHERE task_id=?").run(new Date().toISOString(), id); this.snapshot(); }
  output(id, channel, text) {
    if (!['stdout', 'stderr'].includes(channel)) throw new Error('INVALID_CHANNEL');
    this.db.prepare(`UPDATE tasks SET ${channel}=${channel}||?,updated_at=? WHERE task_id=?`).run(text, new Date().toISOString(), id);
    this.snapshot();
  }
  finish(id, status, result) {
    this.db.prepare('UPDATE tasks SET status=?,result=?,updated_at=? WHERE task_id=?').run(status, JSON.stringify(result), new Date().toISOString(), id);
    this.snapshot();
  }
  get(scope, id) { return this.decode(this.db.prepare('SELECT * FROM tasks WHERE scope=? AND task_id=?').get(scope, id)); }
  list(scope) {
    const rows = scope ? this.db.prepare('SELECT * FROM tasks WHERE scope=? ORDER BY started_at DESC LIMIT 100').all(scope)
      : this.db.prepare('SELECT * FROM tasks ORDER BY started_at DESC LIMIT 100').all();
    return rows.map(r => {
      const task = this.decode(r);
      return { ...task, stdout: task.stdout.slice(-4096), stderr: task.stderr.slice(-4096),
        result: task.result ? { status: task.result.status, error: task.result.error, exitCode: task.result.exitCode } : null };
    });
  }
  decode(row) { return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null; }
  snapshot() {
    if (!this.snapshotPath) return;
    const tasks = this.list().slice(0, 30).map(t => ({ taskId: t.task_id, deviceId: t.device_id, sessionId: t.session_id,
      status: t.status, action: t.action, target: t.target.slice(0, 256), startedAt: t.started_at, updatedAt: t.updated_at,
      stdout: t.stdout.slice(-512), stderr: t.stderr.slice(-512), error: String(t.result?.error ?? '').slice(0, 256), exitCode: t.result?.exitCode ?? null }));
    const tmp = `${this.snapshotPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), tasks }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, this.snapshotPath);
  }
  close() { this.db.close(); }
}
