import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import './build-mcp.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'lingxi-mcp-package-'));
try {
  for (const directory of ['packages/lingxi-mcp', 'packages/remote-sdk/dist']) await mkdir(join(staging, directory), { recursive: true });
  for (const file of ['cli.mjs', 'service.mjs', 'store.mjs', 'protocol.mjs']) await copyFile(`packages/lingxi-mcp/${file}`, join(staging, 'packages/lingxi-mcp', file));
  await copyFile('packages/remote-sdk/dist/index.mjs', join(staging, 'packages/remote-sdk/dist/index.mjs'));
  await copyFile('REMOTE_TASKS.md', join(staging, 'README.md'));
  await copyFile('LICENSE', join(staging, 'LICENSE'));
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: '@lingxi1949/mcp', version: manifest.version, private: true, type: 'module', engines: { node: '>=24' }, bin: { 'lingxi-mcp': 'packages/lingxi-mcp/cli.mjs' }, dependencies: { '@number0/iroh': '1.1.0' } }, null, 2));
  await mkdir('release-assets', { recursive: true });
  const archive = resolve(`release-assets/lingxi-mcp-${manifest.version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  lingxi-mcp-${manifest.version}.tar.gz\n`);
  console.log(archive);
} finally { await rm(staging, { recursive: true, force: true }); }
