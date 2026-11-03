import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'lingxi-setup-e2e-'));
const agent = resolve(`agent/target/debug/lingxi1949${process.platform === 'win32' ? '.exe' : ''}`);
const setup = resolve('scripts/setup.mjs');
const environments = [];
const home = join(root, 'controller-profile');
async function environment(name) {
  const config = join(root, name); const runtime = join(root, `${name}-runtime`);
  await mkdir(config); await mkdir(runtime, {mode:0o700});
  const env = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config, LOCALAPPDATA: config, XDG_RUNTIME_DIR: runtime };
  environments.push(env); return env;
}
const run = (env, ...args) => exec(process.execPath, [setup, '--agent', agent, '--loopback', 'true', ...args], {env, timeout:90000});
try {
  const targetEnv = await environment('target');
  const targetHome = join(root, 'target-user'); await mkdir(targetHome);
  targetEnv.HOME = targetHome; targetEnv.USERPROFILE = targetHome;
  targetEnv.SHELL = join(root, 'missing-shell');
  const controllerEnv = await environment('controller');
  const work = join(root, 'work'); await mkdir(work);
  const target = await run(targetEnv, '--role','target','--home',join(root,'target-profile'),'--receive-root',work);
  const ticket = target.stdout.match(/code\s+(endpoint[a-z2-7]+)/)?.[1]; assert.ok(ticket);
  const ticketFile = join(root,'ticket'); await writeFile(ticketFile,ticket);
  const args = ['--role','controller','--home',home,'--ticket-file',ticketFile,'--name','Test device','--workdir',work,'--shell',process.platform === 'win32' ? process.env.ComSpec : '/bin/sh','--ai','none'];
  await run(controllerEnv,...args);
  const profile = JSON.parse(await readFile(join(home,'profile.json'),'utf8'));
  const result = JSON.parse(await readFile(join(home,'setup-result.json'),'utf8'));
  assert.equal(result.transport,'ready'); assert.equal(profile.devices.length,1);
  await run(controllerEnv,...args);
  const repeated = JSON.parse(await readFile(join(home,'profile.json'),'utf8'));
  assert.deepEqual(repeated.seed, profile.seed); assert.equal(repeated.devices.length,1);
  const defaultsArgs = args.filter((value, index) => !['--workdir', '--shell'].includes(value) && !['--workdir', '--shell'].includes(args[index - 1]));
  await run(controllerEnv, ...defaultsArgs);
  const defaultsResult = JSON.parse(await readFile(join(home, 'setup-result.json'), 'utf8'));
  const binding = JSON.parse(await readFile(join(home, `session-${defaultsResult.session}.json`), 'utf8'));
  const { realpath, access } = await import('node:fs/promises');
  assert.equal(binding.workDir, await realpath(targetHome));
  await access(binding.shell);
  assert.notEqual(binding.shell, targetEnv.SHELL);
  const cli = resolve('packages/lingxi-mcp/cli.mjs');
  const selected = await exec(process.execPath, [cli, 'select', '--device', defaultsResult.deviceId, '--home', home, '--loopback', 'true'], { env: controllerEnv });
  assert.equal(JSON.parse(selected.stdout).workDir, binding.workDir);
  assert.equal(JSON.parse(selected.stdout).shell, binding.shell);
  const executed = await exec(process.execPath, [cli, 'exec', '--session', JSON.parse(selected.stdout).session, '--command', 'echo lingxi-default-shell', '--home', home, '--loopback', 'true'], { env: controllerEnv });
  assert.match(executed.stdout, /lingxi-default-shell/);
  const bad = [...args]; bad[bad.indexOf('--workdir')+1] = join(root,'missing');
  await assert.rejects(run(controllerEnv,...bad));
  console.log('PASS: real two-end setup, service startup, pairing, binding, repeated identity preservation, target defaults, missing-shell fallback, CLI defaults, explicit overrides, invalid-directory failure. AI account login not tested.');
} finally {
  for (const env of environments) {
    try {
      const {stdout} = await exec(agent,['status'],{env});
      const pid = Number(stdout.match(/agent\s+pid (\d+) \(running\)/)?.[1]);
      if (pid) process.kill(pid,'SIGTERM');
    } catch {}
  }
  await new Promise(resolve => setTimeout(resolve,1000));
  await rm(root,{recursive:true,force:true});
}
