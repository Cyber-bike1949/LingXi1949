import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDownloadArgs, classifyRuns, runCheckedOutSha } from '../src/github.mjs';

test('recognizes a workflow that checked out the exact delivery SHA', () => {
  const sha = '16c2a923d06c0d560bdca1f7a71c7d5b123c3be4';
  assert.equal(runCheckedOutSha(`ref: ${sha}\n[command]/usr/bin/git checkout --progress --force ${sha}\n`, sha), true);
  assert.equal(runCheckedOutSha('ref: 76c50b727512167f8b78c9f1099350ccd47d5a4d\n', sha), false);
});

test('requires every named workflow to complete successfully for the target SHA', () => {
  const good = [{ name: 'CI', status: 'completed', conclusion: 'success' }, { name: 'UI', status: 'completed', conclusion: 'success' }];
  assert.equal(classifyRuns(good, ['CI', 'UI']).passed, true);
  assert.equal(classifyRuns(good.slice(0, 1), ['CI', 'UI']).missing[0], 'UI');
  assert.equal(classifyRuns([{ name: 'CI', status: 'completed', conclusion: 'failure' }], ['CI']).failed.length, 1);
});

test('builds a GitHub CLI download command tied to one run', () => {
  assert.deepEqual(artifactDownloadArgs({ repository: 'owner/project', runId: 42, directory: '/tmp/artifacts' }), ['run', 'download', '42', '--repo', 'owner/project', '--dir', '/tmp/artifacts']);
});
