import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/process.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const sha = 'a'.repeat(40);

function executable(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

test('runs the approved task through remote development, CI/E2E, RC build, and artifact evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-cli-e2e-')); const home = join(root, 'home');
  const remote = join(root, 'fake-lingxi.mjs'); const gh = join(root, 'fake-gh.mjs'); const project = join(root, 'project.json');
  executable(remote, `
const args=process.argv.slice(2); const command=args[args.indexOf('--command')+1] ?? '';
if(args[0]==='config'){ console.log(JSON.stringify({ok:true})); process.exit(0); }
const sha='${sha}'; const stdout=command.includes('rev-parse HEAD') ? 'HEAD:'+sha+'\\nREMOTE:'+sha+'\\n' : 'ok\\n';
console.log(JSON.stringify({exitCode:0,stdout,stderr:''}));`);
  executable(gh, `
import {mkdirSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2); if(a[0]==='run'&&a[1]==='list'){console.log(JSON.stringify([
 {databaseId:1,name:'CI',status:'completed',conclusion:'success',url:'https://example/ci',headSha:'${sha}'},
 {databaseId:2,name:'E2E',status:'completed',conclusion:'success',url:'https://example/e2e',headSha:'${sha}'},
 {databaseId:3,name:'LingXi RC Build',status:'completed',conclusion:'success',url:'https://example/rc',headSha:'${sha}'}]));}
else if(a[0]==='api'){console.log('${sha}');}
else if(a[0]==='run'&&a[1]==='download'){const d=a[a.indexOf('--dir')+1];mkdirSync(d,{recursive:true});writeFileSync(d+'/artifact.txt','rc artifact\\n');}
process.exit(0);`);
  writeFileSync(project, JSON.stringify({ repository: 'owner/example', developmentBranchPattern: 'feat/ai-{taskId}', commands: ['true'], runtime: {
    remotes: { development: { lingxiCli: remote, session: 'dev', worktreeRoot: '/work/dev' }, test: { lingxiCli: remote, session: 'test', worktreeRoot: '/work/test' } },
    agent: { executable: 'codex', args: ['exec', '-'], target: 'remote' }, tester: { executable: 'codex', args: ['exec', '-'], target: 'remote' }, gh,
    workflows: { required: ['CI'], e2eRequired: ['E2E'], e2eDispatch: { workflow: 'e2e.yml' }, rc: { workflow: 'lingxi-rc.yml', required: ['LingXi RC Build'] } }
  } }));
  const requirement = join(root, 'requirement.md'); const cases = join(root, 'cases.md'); writeFileSync(requirement, '# Requirement\n'); writeFileSync(cases, '# Cases\n');
  const create = await runProcess(process.execPath, [cli, 'task-create', '--home', home, '--id', 'RND-E2E', '--title', 'E2E', '--repository', 'owner/example', '--branch', 'feat/ai-RND-E2E', '--base-sha', sha, '--approved-by', 'tester', '--requirement-file', requirement, '--test-case-file', cases]);
  assert.equal(create.exitCode, 0, create.stderr);
  const request = await runProcess(process.execPath, [cli, 'rc-request', '--home', home, '--id', 'RND-E2E', '--version', '1.0.0-rc.1']);
  assert.equal(request.exitCode, 0, request.stderr);
  const run = await runProcess(process.execPath, [cli, 'task-run-all', '--home', home, '--id', 'RND-E2E', '--project', project, '--max-steps', '10']);
  assert.equal(run.exitCode, 0, run.stderr);
  const show = await runProcess(process.execPath, [cli, 'task-show', '--home', home, '--id', 'RND-E2E']);
  const result = JSON.parse(show.stdout);
  assert.equal(result.task.state, 'RC_READY');
  assert.ok(result.nodes.every(node => node.state === 'SUCCEEDED'));
  assert.equal(result.artifacts.length, 1);
  assert.match(result.artifacts[0].sha, /^[0-9a-f]{64}$/);
});
