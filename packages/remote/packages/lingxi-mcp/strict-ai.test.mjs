import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyCodexRuntime } from './strict-ai.mjs';

const exec = promisify(execFile);

test('strict Codex launcher retains ESM package scope in the sandbox', async () => {
  const source = await readFile(new URL('./strict-ai.mjs', import.meta.url), 'utf8');
  assert.match(source, /writeFile\(join\(app, 'package\.json'\), JSON\.stringify\(\{ type: 'module' \}\)/);
  assert.match(source, /kind === 'codex' \? \['--no-daemon'\] : \[\]/);
  assert.match(source, /approval_policy = "never"/);

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

test('strict Codex launcher receives its optional platform package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-codex-runtime-test-'));
  const packageName = `codex-${process.platform}-${process.arch}`;
  const packageRoot = join(root, 'node_modules', '@openai');
  const tool = join(packageRoot, 'codex', 'bin', 'codex.js');
  const app = join(root, 'app');
  try {
    await mkdir(dirname(tool), { recursive: true });
    await mkdir(join(packageRoot, packageName), { recursive: true });
    await writeFile(join(packageRoot, 'codex', 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(tool, `import { createRequire } from 'node:module';\nimport { existsSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nconst require = createRequire(import.meta.url);\nconst vendor = join(dirname(require.resolve('@openai/${packageName}/package.json')), 'vendor', 'codex');\nconsole.log(existsSync(vendor) ? 'available' : 'missing');\n`);
    await writeFile(join(packageRoot, packageName, 'package.json'), JSON.stringify({ type: 'module', exports: { './package.json': './package.json' } }));
    await mkdir(join(packageRoot, packageName, 'vendor'));
    await writeFile(join(packageRoot, packageName, 'vendor', 'codex'), 'native executable');
    await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    const command = await copyCodexRuntime(tool, app);
    assert.equal(command.replaceAll('\\', '/'), '/app/node_modules/@openai/codex/bin/codex.js');
    const relativeCommand = command.replace(/^[/\\]app[/\\]/, '').split(/[/\\]/);
    const { stdout } = await exec(process.execPath, [join(app, ...relativeCommand)]);
    assert.equal(stdout, 'available\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
