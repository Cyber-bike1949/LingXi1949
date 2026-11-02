import { mkdtemp, mkdir, copyFile, cp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import './build-mcp.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'lingxi-remote-package-'));
const platform = process.platform;
if (!['linux', 'win32'].includes(platform) || process.arch !== 'x64') throw new Error('Unsupported release platform');
try {
  for (const directory of ['bin', 'scripts', 'packages/lingxi-mcp', 'packages/remote-sdk/dist']) await mkdir(join(stage, directory), { recursive: true });
  const agent = process.env.LINGXI_AGENT_BINARY ?? `agent/target/release/lingxi1949${platform === 'win32' ? '.exe' : ''}`;
  await copyFile(agent, join(stage, 'bin', `lingxi1949${platform === 'win32' ? '.exe' : ''}`));
  await chmod(join(stage, 'bin', `lingxi1949${platform === 'win32' ? '.exe' : ''}`), 0o755);
  for (const file of ['cli.mjs','manual.mjs','service.mjs','store.mjs','protocol.mjs']) await copyFile(`packages/lingxi-mcp/${file}`, join(stage, 'packages/lingxi-mcp', file));
  await cp('packages/remote-sdk/dist', join(stage, 'packages/remote-sdk/dist'), { recursive: true });
  for (const file of ['setup.sh','setup.ps1','setup.mjs']) await copyFile(`scripts/${file}`, join(stage, 'scripts', file));
  for (const file of ['LICENSE','README.md','package-lock.json']) await copyFile(file, join(stage, file));
  // Keep the production dependency graph compatible with the committed npm lock.
  await writeFile(join(stage, 'package.json'), JSON.stringify({ ...manifest, scripts: {}, devDependencies: manifest.devDependencies }, null, 2));
  await mkdir('release-assets', { recursive: true });
  const name = `lingxi-remote-${manifest.version}-${platform}-x64.tar.gz`;
  const archive = resolve('release-assets', name);
  execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
  console.log(archive);
} finally { await rm(stage, { recursive: true, force: true }); }
