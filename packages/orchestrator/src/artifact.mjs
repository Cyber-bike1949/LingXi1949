import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function walk(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return walk(root, path);
    if (entry.isFile()) return [{ path, relative: relative(root, path).split(sep).join('/') }];
    return [];
  });
}

export function taskArtifactDirectory(root, taskId, runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error('INVALID_TASK_ID_FOR_ARTIFACT_PATH');
  if (!/^\d+$/.test(String(runId))) throw new Error('INVALID_WORKFLOW_RUN_ID');
  const base = resolve(root);
  const directory = resolve(base, taskId, `run-${runId}`);
  if (!directory.startsWith(`${base}${sep}`)) throw new Error('ARTIFACT_PATH_OUTSIDE_ROOT');
  return directory;
}

export function artifactManifest(directory) {
  const root = resolve(directory);
  const files = walk(root).sort((left, right) => left.relative.localeCompare(right.relative)).map(file => ({
    path: file.relative,
    bytes: statSync(file.path).size,
    sha256: digest(readFileSync(file.path))
  }));
  return { directory: root, files, sha256: digest(JSON.stringify(files)) };
}
