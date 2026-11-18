import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactManifest, taskArtifactDirectory } from '../src/artifact.mjs';

test('creates a deterministic artifact manifest and safe task path', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-artifacts-'));
  const directory = taskArtifactDirectory(root, 'RND-001', 123);
  mkdirSync(join(directory, 'nested'), { recursive: true });
  writeFileSync(join(directory, 'nested', 'report.txt'), 'passed\n');
  writeFileSync(join(directory, 'result.json'), '{"ok":true}\n');
  const manifest = artifactManifest(directory);
  assert.deepEqual(manifest.files.map(file => file.path), ['nested/report.txt', 'result.json']);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => taskArtifactDirectory(root, '../escape', 123), /INVALID_TASK_ID/);
});
