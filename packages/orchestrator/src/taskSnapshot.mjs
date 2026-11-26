import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { powershellCommand, powershellLiteral } from './shell.mjs';
import { decodeLingxiResult, runLingxiCommand, runLingxiUpload } from './remote.mjs';

const safeNodeData = new Set(['deliverySha', 'sha', 'clean', 'exitCode', 'target', 'version', 'passed', 'timedOut', 'missing', 'failed', 'pending', 'selected']);

function projectTask(store, task) {
  const events = store.events(task.id);
  const testOutput = [...events].reverse().find(event => event.type === 'AGENT_FINISHED' && event.data?.role === 'tester')?.data?.stdout ?? '';
  const reportUrl = testOutput.match(/handoffReport[^\n]*(https:\/\/github\.com\/[^\s)\]]+)/i)?.[1] ?? null;
  const released = [...events].reverse().find(event => event.type === 'STATE_CHANGED' && event.data?.state === 'RELEASED')?.data ?? null;
  const testResults = testOutput.match(/testResults[^\n]*/i)?.[0]?.replace(/^[-*\s]+/, '') ?? null;
  const nodes = store.nodes(task.id).map(node => ({
    kind: node.kind,
    state: node.state,
    updatedAt: node.updatedAt,
    data: Object.fromEntries(Object.entries(node.data ?? {}).filter(([key]) => safeNodeData.has(key)).map(([key, value]) => [key, key === 'selected' && Array.isArray(value)
      ? value.map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, url: run.url, databaseId: run.databaseId }))
      : value])),
  }));
  let currentNode = null;
  const nodeStartedAt = new Map();
  const eventDurations = new Map();
  for (const event of events) {
    if (event.type === 'TASK_NODE_DISPATCHED') {
      currentNode = event.data?.kind ?? null;
      if (currentNode) nodeStartedAt.set(currentNode, Date.parse(event.createdAt));
    }
    if (event.type === 'TASK_NODE_FINISHED' && currentNode === event.data?.kind) {
      const startedAt = nodeStartedAt.get(currentNode);
      const finishedAt = Date.parse(event.createdAt);
      if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) eventDurations.set(event.id, finishedAt - startedAt);
      nodeStartedAt.delete(currentNode);
      currentNode = null;
    }
  }
  return {
    ...task,
    currentNode,
    nodes,
    workflows: store.workflows(task.id).map(({ sha, name, runId, url, status, conclusion, recordedAt }) => ({ sha, name, runId, url, status, conclusion, recordedAt })),
    artifacts: store.artifacts(task.id).map(({ kind, sha }) => ({ kind, sha })),
    testReport: { url: reportUrl, results: testResults },
    release: released ? { tag: released.tag ?? null, url: released.releaseUrl ?? null, sha: released.sha ?? null } : null,
    eventCount: events.length,
    eventsTruncated: events.length > 100,
    events: events.slice(-100).map(event => {
      const data = Object.fromEntries(Object.entries(event.data ?? {}).filter(([key]) => ['kind', 'state', 'reason', 'role', 'source', 'sha', 'workflow', 'version', 'tag', 'releaseUrl', 'exitCode', 'errorCode', 'traceId', 'executionId'].includes(key)));
      if (typeof data.reason === 'string') data.reason = data.reason.slice(0, 200);
      const durationMs = eventDurations.get(event.id);
      if (durationMs !== undefined) data.durationMs = durationMs;
      return { id: event.id, type: event.type, createdAt: event.createdAt, data };
    }),
  };
}

export function buildTaskSnapshot(store, repository) {
  const tasks = store.list().filter(task => task.repository === repository).slice(0, 30).map(task => projectTask(store, task));
  return { schemaVersion: 1, source: 'lingxi-orchestrator', repository, updatedAt: new Date().toISOString(), tasks };
}

export function snapshotDirectoryCommand({ remotePath, shellKind = 'posix' }) {
  const pathApi = shellKind === 'cmd' ? win32 : posix;
  if (!remotePath || pathApi.isAbsolute(remotePath) || pathApi.normalize(remotePath).split(/[\\/]/).includes('..')) throw new Error('TASK_MIRROR_PATH_MUST_BE_RELATIVE');
  const directory = pathApi.dirname(remotePath);
  if (!directory || directory === '.') throw new Error('TASK_MIRROR_DIRECTORY_REQUIRED');
  if (shellKind === 'cmd') {
    const script = `$ErrorActionPreference = 'Stop'; $root = (Get-Location).Path; $target = Join-Path $root ${powershellLiteral(directory)}; New-Item -ItemType Directory -Force -Path $target | Out-Null`;
    return powershellCommand(script);
  }
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `mkdir -p ${quote(directory)}`;
}

export function snapshotFinalizeCommand({ remotePath, remoteFinalPath, shellKind = 'posix' }) {
  const pathApi = shellKind === 'cmd' ? win32 : posix;
  if (!remotePath || pathApi.isAbsolute(remotePath) || pathApi.normalize(remotePath).split(/[\\/]/).includes('..')) throw new Error('TASK_MIRROR_PATH_MUST_BE_RELATIVE');
  if (!remoteFinalPath || !pathApi.isAbsolute(remoteFinalPath)) throw new Error('TASK_MIRROR_FINAL_PATH_MUST_BE_ABSOLUTE');
  if (shellKind === 'cmd') {
    const script = `$ErrorActionPreference = 'Stop'; $root = (Get-Location).Path; $source = Join-Path $root ${powershellLiteral(remotePath)}; $target = ${powershellLiteral(remoteFinalPath)}; $parent = Split-Path -Parent $target; New-Item -ItemType Directory -Force -Path $parent | Out-Null; $temp = "$target.tmp"; Copy-Item -LiteralPath $source -Destination $temp -Force; Move-Item -LiteralPath $temp -Destination $target -Force; Remove-Item -LiteralPath $source -Force; $stage = Split-Path -Parent $source; if ((Get-ChildItem -LiteralPath $stage -Force | Measure-Object).Count -eq 0) { Remove-Item -LiteralPath $stage -Force }`;
    return powershellCommand(script);
  }
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const source = pathApi.resolve(remotePath);
  const target = pathApi.resolve(remoteFinalPath);
  return `mkdir -p ${quote(pathApi.dirname(target))} && cp ${quote(source)} ${quote(`${target}.tmp`)} && mv -f ${quote(`${target}.tmp`)} ${quote(target)} && rm ${quote(source)} && (rmdir ${quote(pathApi.dirname(source))} 2>/dev/null || true)`;
}

export async function publishTaskSnapshot({ store, repository, remote, remotePath, remoteFinalPath }) {
  if (!remotePath) return { skipped: true, reason: 'TASK_MIRROR_PATH_NOT_CONFIGURED' };
  const snapshot = buildTaskSnapshot(store, repository);
  const content = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error('TASK_MIRROR_SIZE_LIMIT');
  const pathApi = remote.shellKind === 'cmd' ? win32 : posix;
  const normalizedPath = pathApi.normalize(remotePath);
  const directoryResult = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: snapshotDirectoryCommand({ remotePath: normalizedPath, shellKind: remote.shellKind }), timeoutMs: 30000 });
  const directoryEnvelope = decodeLingxiResult(directoryResult.stdout);
  if (directoryResult.exitCode !== 0 || directoryEnvelope.status !== 'SUCCESS' || directoryEnvelope.exitCode !== 0) throw new Error(`TASK_MIRROR_DIRECTORY_FAILED: ${directoryResult.stderr.slice(-1000)}`);
  const tempDirectory = mkdtempSync(join(tmpdir(), 'lingxi-task-mirror-'));
  const localPath = join(tempDirectory, 'tasks.json');
  try {
    writeFileSync(localPath, content, { encoding: 'utf8', mode: 0o600 });
    const upload = await runLingxiUpload({ cli: remote.lingxiCli, session: remote.session, localPath, remotePath: normalizedPath });
    if (upload.exitCode !== 0) throw new Error(`TASK_MIRROR_WRITE_FAILED: ${upload.stderr.slice(-1000)}`);
    const finalized = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: snapshotFinalizeCommand({ remotePath: normalizedPath, remoteFinalPath, shellKind: remote.shellKind }), timeoutMs: 30000 });
    const finalizeEnvelope = decodeLingxiResult(finalized.stdout);
    if (finalized.exitCode !== 0 || finalizeEnvelope.status !== 'SUCCESS' || finalizeEnvelope.exitCode !== 0) throw new Error(`TASK_MIRROR_FINALIZE_FAILED: ${finalized.stderr.slice(-1000)}`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
  return { remotePath: remoteFinalPath, taskCount: snapshot.tasks.length, updatedAt: snapshot.updatedAt };
}
