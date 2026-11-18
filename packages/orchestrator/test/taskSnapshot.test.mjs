import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskSnapshot, snapshotDirectoryCommand, snapshotFinalizeCommand } from '../src/taskSnapshot.mjs';

test('projects task progress and test report links without copying raw agent output', () => {
  const store = {
    list: () => [{ id: 'RND-001', repository: 'owner/demo', state: 'RC_READY' }],
    events: () => [
      { type: 'TASK_NODE_DISPATCHED', data: { kind: 'develop' }, createdAt: '2026-01-01T00:00:00Z' },
      { type: 'TASK_NODE_FINISHED', data: { kind: 'develop', state: 'SUCCEEDED' }, createdAt: '2026-01-01T00:01:00Z' },
      { type: 'AGENT_FINISHED', data: { role: 'tester', stdout: 'testResults: 7/7 passed\n**handoffReport**: [report](https://github.com/owner/demo/blob/abc/TEST-HANDOFF.md)\nPRIVATE_SECRET=do-not-copy' }, createdAt: '2026-01-01T00:02:00Z' },
    ],
    nodes: () => [{ kind: 'test', state: 'SUCCEEDED', updatedAt: 'now', data: { exitCode: 0, stdout: 'PRIVATE_SECRET=do-not-copy' } }],
    workflows: () => [{ sha: 'abc', name: 'Web Demo E2E', runId: '1', url: 'https://github.com/owner/demo/actions/runs/1', status: 'completed', conclusion: 'success', recordedAt: 'now' }],
    artifacts: () => [{ kind: 'rc-0.1.0-rc.1', location: '/private/path', sha: 'abc' }],
  };
  const snapshot = buildTaskSnapshot(store, 'owner/demo');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.tasks[0].currentNode, null);
  assert.equal(snapshot.tasks[0].testReport.url, 'https://github.com/owner/demo/blob/abc/TEST-HANDOFF.md');
  assert.match(snapshot.tasks[0].testReport.results, /7\/7 passed/);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SECRET'), false);
  assert.equal(JSON.stringify(snapshot).includes('/private/path'), false);
});

test('creates a safe remote snapshot directory through PowerShell', () => {
  const command = snapshotDirectoryCommand({ remotePath: '.lingxi-orchestrator\\tasks.json', shellKind: 'cmd' });
  assert.match(command, /powershell\.exe .*EncodedCommand/);
  assert.throws(() => snapshotDirectoryCommand({ remotePath: '..\\outside\\tasks.json', shellKind: 'cmd' }), /TASK_MIRROR_PATH_MUST_BE_RELATIVE/);
  const finalize = snapshotFinalizeCommand({ remotePath: '.lingxi-orchestrator\\tasks.json', remoteFinalPath: 'D:\\LingXi\\orchestrator\\tasks.json', shellKind: 'cmd' });
  const encoded = finalize.match(/EncodedCommand (.+)$/)?.[1];
  assert.ok(encoded);
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /Move-Item -LiteralPath/);
  assert.throws(() => snapshotFinalizeCommand({ remotePath: '.lingxi-orchestrator\\tasks.json', remoteFinalPath: 'relative\\tasks.json', shellKind: 'cmd' }), /TASK_MIRROR_FINAL_PATH_MUST_BE_ABSOLUTE/);
});
