import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('strict Codex launcher retains ESM package scope in the sandbox', async () => {
  const source = await readFile(new URL('./strict-ai.mjs', import.meta.url), 'utf8');
  assert.match(source, /writeFile\(join\(app, 'package\.json'\), JSON\.stringify\(\{ type: 'module' \}\)/);

  const app = await mkdtemp(join(tmpdir(), 'lingxi-strict-ai-test-'));
  try {
    const launcher = join(app, 'codex');
    await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(launcher, "import { basename } from 'node:path';\nconsole.log(basename('codex'));\n");
    const { stdout } = await exec(process.execPath, [launcher]);
    assert.equal(stdout, 'codex\n');
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});
