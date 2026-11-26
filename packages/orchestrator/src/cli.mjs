#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorStore } from './store.mjs';
import { joinRemotePath, readProject, runtimeConfig, sha256File, taskPrompt } from './project.mjs';
import { decodeLingxiResult, runLingxiCommand } from './remote.mjs';
import { parseVerification, verificationCommand } from './git.mjs';
import { blockedBy, nextNodes, retryKinds } from './scheduler.mjs';
import { nextAction } from './engine.mjs';
import { runProcess } from './process.mjs';
import { dispatchWorkflow, downloadRunArtifacts, getBranchSha, waitForRequiredRuns, waitForRelease } from './github.mjs';
import { artifactManifest, taskArtifactDirectory } from './artifact.mjs';
import { worktreeLeaseKey } from './resources.mjs';
import { formalTagCommand, validFormalTag } from './release.mjs';
import { documentDraftPrompt } from './draft.mjs';
import { runnableTasks, wait } from './worker.mjs';
import { preflightPlan, safeSummary } from './preflight.mjs';
import { agentConfigArgs, remoteAgentCommand, resumeAgentArgs, runAgent } from './agent.mjs';
import { evaluateRcGate } from './gate.mjs';
import { approvedTaskInput, serve } from './server.mjs';
import { qualityCommand, worktreeCommand } from './pipeline.mjs';
import { powershellCommand, powershellLiteral } from './shell.mjs';
import { publishTaskSnapshot } from './taskSnapshot.mjs';
import { quotaFailure, quotaRetryAt } from './quota.mjs';
import { checkRootlessDocker, runDockerAgent } from './dockerSandbox.mjs';
import { flushNotificationOutbox, notificationConfig } from './notifications.mjs';

const [command, ...argv] = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`INVALID_OPTION: ${argv[index]}`);
  options[argv[index].slice(2)] = argv[index + 1];
}
const home = resolve(options.home ?? join(homedir(), '.lingxi-orchestrator'));
mkdirSync(home, { recursive: true, mode: 0o700 });
const databasePath = join(home, 'orchestrator.sqlite');
const store = new OrchestratorStore(databasePath);
chmodSync(databasePath, 0o600);
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const required = key => { if (!options[key]) throw new Error(`MISSING_${key.toUpperCase().replaceAll('-', '_')}`); return options[key]; };
async function executeConfiguredAgent({ agent, prompt, remote, taskId, role, sandbox }) {
  const previous = [...store.events(taskId)].reverse().find(event => event.type === 'AGENT_SESSION' && event.data?.role === role)?.data?.sessionId;
  const args = resumeAgentArgs(agent, previous);
  const onSession = sessionId => store.event(taskId, 'AGENT_SESSION', { role, sessionId, capturedAt: new Date().toISOString() });
  if (agent.target !== 'remote') {
    const localPrompt = agent.mcp ? {
      ...prompt,
      execution: {
        target: 'controlled-device-via-lingxi-mcp',
        worktree: prompt.worktree,
        rules: [
          'The assigned repository and worktree exist only on the controlled device; use the configured LingXi MCP remote_* tools for every project operation.',
          'Never use the controller local shell, filesystem, or Git to inspect or change the assigned project.',
          'The LingXi MCP binding is fixed to the approved device and must not be changed.'
        ]
      }
    } : prompt;
    const result = sandbox?.enabled === true
      ? await runDockerAgent({ config: sandbox, agent, args, prompt: localPrompt, remote, stateRoot: home, taskId, role, onSession })
      : await runAgent({ executable: agent.executable, args, mcp: agent.mcp, prompt: localPrompt, onSession });
    return { ...result, target: 'local' };
  }
  const command = remoteAgentCommand({ executable: agent.executable, args, prompt, worktree: prompt.worktree, shellKind: remote.shellKind });
  const controller = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command, timeoutMs: agent.timeoutMs ?? 3600000 });
  if (controller.exitCode !== 0) return { ...controller, target: 'remote' };
  const result = decodeLingxiResult(controller.stdout);
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', target: 'remote' };
}
function leaseWorktree(task, remote, worktree) {
  const lease = store.acquire(worktreeLeaseKey(remote, worktree), task.id, 7200000);
  store.event(task.id, 'WORKTREE_LEASE_ACQUIRED', { ...lease, worktree, resourceId: remote.resourceId ?? remote.session });
  return lease;
}
function releaseWorktree(task, remote, worktree) {
  const key = worktreeLeaseKey(remote, worktree);
  store.release(key, task.id);
  store.event(task.id, 'WORKTREE_LEASE_RELEASED', { key, worktree });
}
async function validateProjectRuntime(project) {
  const runtime = runtimeConfig(project); const plan = preflightPlan({ project, runtime }); const checks = [];
  if (runtime.sandbox?.enabled === true) {
    try { await checkRootlessDocker(runtime.sandbox); checks.push({ kind: 'rootless-docker', exitCode: 0 }); }
    catch (error) { checks.push({ kind: 'rootless-docker', exitCode: 1, stderr: error.message }); }
  }
  for (const remote of plan.remotes) {
    const config = await runProcess(process.execPath, [remote.cli, 'config', '--session', remote.session]);
    checks.push({ kind: `lingxi-session:${remote.role}`, ...safeSummary(config) });
    const probeCommand = remote.shellKind === 'cmd'
      ? powershellCommand(`& git --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ${remote.repositoryRoot ? `& git -C ${powershellLiteral(remote.repositoryRoot)} rev-parse --show-toplevel; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };` : ''} exit 0`)
      : `command -v git && git --version${remote.repositoryRoot ? ` && git -C '${remote.repositoryRoot.replaceAll("'", "'\\''")}' rev-parse --show-toplevel` : ''}`;
    const probe = await runLingxiCommand({ cli: remote.cli, session: remote.session, command: probeCommand });
    checks.push({ kind: `remote-git:${remote.role}`, ...safeSummary(probe) });
  }
  for (const agent of [
    { role: 'developer', ...runtime.agent, remote: runtime.remotes.development },
    { role: 'tester', ...runtime.tester, remote: runtime.remotes.test }
  ]) {
    const result = agent.target === 'remote'
      ? await runLingxiCommand({ cli: agent.remote.lingxiCli, session: agent.remote.session, command: agent.remote.shellKind === 'cmd' ? `where.exe ${agent.executable}` : `command -v '${agent.executable.replaceAll("'", "'\\''")}'` })
      : await runProcess(agent.executable, ['--version']);
    checks.push({ kind: `agent:${agent.role}`, ...safeSummary(result) });
    if (agent.target === 'local' && agent.executable.toLowerCase().includes('codex')) {
      checks.push({ kind: `agent-auth:${agent.role}`, ...safeSummary(await runProcess(agent.executable, ['login', 'status'])) });
      if (agent.mcp) {
        const mcpArgs = agentConfigArgs({ args: ['mcp', 'get', agent.mcp.name, '--json'], mcp: agent.mcp });
        checks.push({ kind: `agent-mcp:${agent.role}`, ...safeSummary(await runProcess(agent.executable, mcpArgs)) });
      }
    } else if (agent.target === 'remote' && agent.executable.toLowerCase().includes('codex')) {
      const authCommand = agent.remote.shellKind === 'cmd' ? powershellCommand('& codex login status; exit $LASTEXITCODE') : 'codex login status';
      const auth = await runLingxiCommand({ cli: agent.remote.lingxiCli, session: agent.remote.session, command: authCommand });
      checks.push({ kind: `agent-auth:${agent.role}`, ...safeSummary(auth) });
    }
  }
  const gh = runtime.gh ?? 'gh';
  checks.push({ kind: 'github-auth', ...safeSummary(await runProcess(gh, ['auth', 'status'])) });
  for (const workflow of plan.workflows) checks.push({ kind: `workflow:${workflow}`, ...safeSummary(await runProcess(gh, ['workflow', 'view', workflow, '--repo', project.repository])) });
  return { plan, checks, passed: checks.every(check => check.exitCode === 0) };
}

try {
  if (command === 'init') {
    print({ initialized: true, home, note: 'Existing LingXi manual control, pairing, sessions, and AI CLI bindings are not modified.' });
  } else if (command === 'serve') {
    const host = options.host ?? '127.0.0.1';
    const authToken = process.env.LINGXI_ORCHESTRATOR_TOKEN;
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!loopback && (!authToken || authToken.length < 32 || options['tls-terminated'] !== 'true')) throw new Error('NON_LOOPBACK_SERVE_REQUIRES_AUTH_AND_TLS_TERMINATION');
    if (authToken && authToken.length < 32) throw new Error('ORCHESTRATOR_TOKEN_MUST_BE_AT_LEAST_32_CHARACTERS');
    const projectPath = options.project ? resolve(options.project) : null;
    const project = projectPath ? readProject(projectPath) : null;
    const runtime = project ? runtimeConfig(project) : null;
    const runningTasks = new Set();
    let createTask = null; let runTask = null; let writeDisabledReason = '项目与访问令牌未同时配置';
    if (authToken && project) {
      const preflight = await validateProjectRuntime(project);
      if (preflight.passed) writeDisabledReason = null;
      else writeDisabledReason = `执行环境预检未通过：${preflight.checks.filter(check => check.exitCode !== 0).map(check => check.kind).join('、')}`;
      print({ preflightPassed: preflight.passed, failedChecks: preflight.checks.filter(check => check.exitCode !== 0).map(check => check.kind) });
    }
    if (!writeDisabledReason) createTask = async input => {
      const defaultBranch = project.defaultBranch ?? 'main';
      const head = await runProcess(runtime.gh ?? 'gh', ['api', `repos/${project.repository}/commits/${defaultBranch}`, '--jq', '.sha']);
      const baseSha = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('GITHUB_DEFAULT_BRANCH_SHA_UNAVAILABLE');
      const id = `RND-${randomUUID().slice(0, 8).toUpperCase()}`;
      const branch = String(project.developmentBranchPattern).replaceAll('{taskId}', id);
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) throw new Error('PROJECT_BRANCH_PATTERN_UNSAFE');
      return store.createTask(approvedTaskInput({ id, title: input.title, repository: project.repository, branch, baseSha, approvedBy: input.approvedBy, requirementContent: input.requirementContent, testCaseContent: input.testCaseContent }));
    };
    if (!writeDisabledReason) runTask = async id => {
      const task = store.get(id);
      if (task.repository !== project.repository) throw new Error('TASK_REPOSITORY_NOT_ALLOWED');
      if (runningTasks.has(id)) throw new Error('TASK_ALREADY_RUNNING');
      if (task.state !== 'TEST_CASES_APPROVED' || store.nodes(id).length) throw new Error('TASK_NOT_STARTABLE');
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'task-run-all', '--id', id, '--project', projectPath, '--home', home, '--max-steps', '10'], { stdio: 'ignore', detached: true });
      runningTasks.add(id);
      store.event(id, 'WEB_TASK_RUN_STARTED', { pid: child.pid, startedAt: new Date().toISOString() });
      child.once('error', error => { runningTasks.delete(id); store.event(id, 'WEB_TASK_RUN_LAUNCH_FAILED', { message: error.message }); });
      child.once('close', exitCode => { runningTasks.delete(id); store.event(id, 'WEB_TASK_RUN_PROCESS_EXITED', { exitCode }); });
      child.unref();
      return { id, state: task.state, started: true };
    };
    const server = await serve(store, { port: Number(options.port ?? 43194), host, authToken, createTask, runTask, writeDisabledReason, projectInfo: project ? { repository: project.repository, defaultBranch: project.defaultBranch ?? 'main' } : null });
    print({ listening: `http://${host}:${server.address().port}`, mode: createTask && runTask ? 'authenticated-task-intake' : 'read-only', writeDisabledReason, endpoints: ['/health', '/meta', '/tasks', '/tasks/:id'] });
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await new Promise(resolve => server.close(resolve));
  } else if (command === 'worker') {
    const project = required('project'); const workerProject = readProject(project); const noticeConfig = notificationConfig(workerProject.runtime, process.env); const intervalMs = Number(options['interval-ms'] ?? 30000); const maxSteps = Number(options['max-steps'] ?? 10);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('INVALID_WORKER_INTERVAL');
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) throw new Error('INVALID_MAX_STEPS');
    const startupRecovery = store.recover();
    print({ worker: 'startup-recovery', recovery: startupRecovery });
    let stopped = false; let notificationFlushPromise = null; const stop = () => { stopped = true; };
    const flushNotifications = () => {
      if (notificationFlushPromise) return notificationFlushPromise;
      notificationFlushPromise = flushNotificationOutbox(store, { config: noticeConfig })
        .finally(() => { notificationFlushPromise = null; });
      return notificationFlushPromise;
    };
    const backgroundTimer = setInterval(() => {
      try { store.wakeDueQuotaTasks(Date.now()); }
      catch (error) { console.error(`QUOTA_SCHEDULER_FAILED:${error.message}`); }
      void flushNotifications().catch(error => console.error(`NOTIFICATION_FLUSH_FAILED:${error.message}`));
    }, Math.min(intervalMs, 60_000));
    backgroundTimer.unref?.();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      while (!stopped) {
        const awakenedQuotaTasks = store.wakeDueQuotaTasks(Date.now());
        const cycle = [];
        for (const task of runnableTasks(store.list(), { autoRelease: workerProject.runtime?.release?.autoAfterGate === true })) {
          const args = [fileURLToPath(import.meta.url), 'task-run-all', '--id', task.id, '--project', project, '--home', home, '--max-steps', String(maxSteps)];
          if (options['auto-retry'] === 'true') args.push('--auto-retry', 'true');
          const result = await runProcess(process.execPath, args);
          cycle.push({ taskId: task.id, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        }
        const notifications = await flushNotifications();
        print({ worker: 'cycle-complete', awakenedQuotaTasks, tasks: cycle, notifications, nextPollMs: intervalMs });
        if (!stopped) await wait(intervalMs);
      }
    } finally {
      clearInterval(backgroundTimer);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  } else if (command === 'preflight' || command === 'doctor') {
    print(await validateProjectRuntime(readProject(required('project'))));
  } else if (command === 'task-create') {
    for (const key of ['title', 'repository', 'branch', 'base-sha', 'approved-by']) required(key);
    const requirementFile = required('requirement-file'); const testCaseFile = required('test-case-file');
    const requirementContent = readFileSync(requirementFile, 'utf8'); const testCaseContent = readFileSync(testCaseFile, 'utf8');
    const requirementHash = sha256File(requirementFile); const testCaseHash = sha256File(testCaseFile);
    if (options['requirement-hash'] && options['requirement-hash'] !== requirementHash) throw new Error('APPROVED_REQUIREMENT_HASH_MISMATCH');
    if (options['test-case-hash'] && options['test-case-hash'] !== testCaseHash) throw new Error('APPROVED_TEST_CASE_HASH_MISMATCH');
    print(store.createTask({ id: options.id, title: options.title, repository: options.repository, branch: options.branch, baseSha: options['base-sha'], requirementHash, testCaseHash, requirementContent, testCaseContent, approvedBy: options['approved-by'] }));
  } else if (command === 'document-draft') {
    const kind = required('kind'); const input = required('input'); const output = required('output');
    const args = options['args-json'] ? JSON.parse(options['args-json']) : [];
    if (!Array.isArray(args)) throw new Error('AGENT_ARGS_MUST_BE_ARRAY');
    const result = await runAgent({ executable: required('executable'), args, prompt: documentDraftPrompt({ kind, source: readFileSync(input, 'utf8') }) });
    if (result.exitCode !== 0) throw new Error(`DOCUMENT_DRAFT_FAILED: ${result.stderr.trim()}`);
    if (!result.stdout.trim()) throw new Error('DOCUMENT_DRAFT_EMPTY');
    writeFileSync(output, result.stdout, { encoding: 'utf8', mode: 0o600 });
    print({ kind, input, output, sha256: sha256File(output), approved: false });
  } else if (command === 'task-list') print(store.list());
  else if (command === 'task-show') { const id = required('id'); const nodes = store.nodes(id); print({ task: store.get(id), nodes, ready: nextNodes(nodes), blocked: blockedBy(nodes), workflows: store.workflows(id), artifacts: store.artifacts(id), events: store.events(id) }); }
  else if (command === 'task-plan') print(store.plan(required('id'), ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build', 'rc']));
  else if (command === 'task-mirror') {
    const task = store.get(required('id')); const project = readProject(required('project'));
    if (task.repository !== project.repository) throw new Error('TASK_REPOSITORY_NOT_ALLOWED');
    const remote = runtimeConfig(project).remotes.development;
    const result = await publishTaskSnapshot({ store, repository: project.repository, remote, remotePath: project.runtime?.taskMirror?.remotePath, remoteFinalPath: project.runtime?.taskMirror?.remoteFinalPath });
    store.event(task.id, result.skipped ? 'TASK_MIRROR_SKIPPED' : 'TASK_MIRROR_UPDATED', result);
    print(result);
  }
  else if (command === 'node-transition') { store.node(required('id'), required('kind'), required('state'), {}); print(store.nodes(options.id)); }
  else if (command === 'artifact-record') { store.artifact(required('id'), required('kind'), required('location'), options.sha); print(store.artifacts(options.id)); }
  else if (command === 'task-transition') { store.transition(required('id'), required('state'), {}); print(store.get(options.id)); }
  else if (command === 'task-prompt') {
    const project = readProject(required('project'));
    const task = store.get(required('id'));
    print(taskPrompt(task, options.role ?? 'developer', project, store.approvedDocuments(task.id)));
  } else if (command === 'task-agent-run') {
    const task = store.get(required('id')); const project = readProject(required('project'));
    const role = options.role ?? 'developer'; const args = options['args-json'] ? JSON.parse(options['args-json']) : [];
    if (!Array.isArray(args)) throw new Error('AGENT_ARGS_MUST_BE_ARRAY');
    const kind = role === 'tester' ? 'test' : 'develop';
    store.node(task.id, kind, 'RUNNING', { executable: required('executable') });
    const result = await runAgent({ executable: options.executable, args, prompt: taskPrompt(task, role, project, store.approvedDocuments(task.id)) });
    store.event(task.id, 'AGENT_FINISHED', { role, executable: options.executable, ...result });
    store.node(task.id, kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { exitCode: result.exitCode });
    if (result.exitCode !== 0) store.transition(task.id, 'FIXING', { reason: 'AGENT_FAILED', role });
    print(result);
  } else if (command === 'task-run-next') {
    const task = store.get(required('id')); const project = readProject(required('project')); const runtime = runtimeConfig(project);
    if (!store.nodes(task.id).length) store.plan(task.id, ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build', 'rc']);
    const action = nextAction(store.nodes(task.id));
    if (!action) { print({ action: null, reason: 'NO_READY_NODE' }); }
    else if (action.kind === 'prepare-worktree') {
      const remote = runtime.remotes.development; const worktree = joinRemotePath(remote, task.id);
      leaseWorktree(task, remote, worktree);
      store.node(task.id, action.kind, 'RUNNING', { worktree });
      const result = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: worktreeCommand({ baseSha: task.baseSha, branch: task.branch, worktree, repositoryRoot: remote.repositoryRoot, shellKind: remote.shellKind }) });
      store.event(task.id, 'WORKTREE_PREPARED', { worktree, ...result });
      store.node(task.id, action.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { worktree, exitCode: result.exitCode });
      if (result.exitCode !== 0) { releaseWorktree(task, remote, worktree); store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'WORKTREE_PREPARE_FAILED' }); }
      print({ action, worktree, ...result });
    } else if (action.kind === 'develop') {
      const remote = runtime.remotes.development; const worktree = joinRemotePath(remote, task.id);
      leaseWorktree(task, remote, worktree);
      const prompt = { ...taskPrompt(task, 'developer', project, store.approvedDocuments(task.id)), worktree };
      store.node(task.id, action.kind, 'RUNNING', { worktree, role: 'developer' });
      const result = await executeConfiguredAgent({ agent: runtime.agent, prompt, remote, sandbox: runtime.sandbox, taskId: task.id, role: 'developer' });
      store.event(task.id, 'AGENT_FINISHED', { role: 'developer', ...result });
      const quota = quotaFailure(result);
      if (quota) {
        store.waitForQuota(task.id, action.kind, { retryAt: quotaRetryAt(quota, { ...(runtime.quota ?? {}), attempt: store.events(task.id).filter(event => event.type === 'QUOTA_WAIT_STARTED').length }), evidence: quota, maxTotalWaitMs: runtime.quota?.maxTotalWaitMs ?? 24 * 60 * 60_000 });
      } else {
        store.node(task.id, action.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { exitCode: result.exitCode });
        if (result.exitCode !== 0) store.transition(task.id, 'FIXING', { reason: 'AGENT_FAILED', role: 'developer' });
      }
      print({ action, ...result });
    } else if (action.kind === 'git-verify') {
      const remote = runtime.remotes.development; const worktree = joinRemotePath(remote, task.id);
      leaseWorktree(task, remote, worktree);
      const result = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: verificationCommand(worktree, task.branch, remote.shellKind) });
      if (result.exitCode !== 0) throw new Error('GIT_VERIFICATION_COMMAND_FAILED');
      const remoteResult = decodeLingxiResult(result.stdout); const branchSha = await getBranchSha({ gh: runtime.gh, repository: task.repository, branch: task.branch }); const evidence = parseVerification(remoteResult.stdout ?? '', branchSha);
      store.event(task.id, 'GIT_VERIFIED', { worktree, ...evidence });
      store.node(task.id, action.kind, evidence.clean ? 'SUCCEEDED' : 'FAILED', { worktree, ...evidence });
      if (!evidence.clean) store.transition(task.id, 'FIXING', { reason: 'GIT_WORKTREE_DIRTY', worktree });
      print({ action, ...evidence });
    } else if (action.kind === 'prepare-test-worktree') {
      const remote = runtime.remotes.test; const worktree = joinRemotePath(remote, task.id); const deliverySha = store.deliverySha(task.id);
      leaseWorktree(task, remote, worktree);
      store.node(task.id, action.kind, 'RUNNING', { worktree, deliverySha });
      const result = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: worktreeCommand({ baseSha: deliverySha, worktree, repositoryRoot: remote.repositoryRoot, shellKind: remote.shellKind }) });
      store.event(task.id, 'TEST_WORKTREE_PREPARED', { worktree, deliverySha, ...result });
      store.node(task.id, action.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { worktree, deliverySha, exitCode: result.exitCode });
      if (result.exitCode !== 0) { releaseWorktree(task, remote, worktree); store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'TEST_WORKTREE_PREPARE_FAILED' }); }
      print({ action, worktree, deliverySha, ...result });
    } else if (action.kind === 'test') {
      const remote = runtime.remotes.test; const worktree = joinRemotePath(remote, task.id); const deliverySha = store.deliverySha(task.id);
      leaseWorktree(task, remote, worktree);
      store.node(task.id, action.kind, 'RUNNING', { worktree, role: 'tester', deliverySha });
      const result = await executeConfiguredAgent({ agent: runtime.tester, remote, sandbox: runtime.sandbox, taskId: task.id, role: 'tester', prompt: { ...taskPrompt(task, 'tester', project, store.approvedDocuments(task.id)), worktree, deliverySha } });
      store.event(task.id, 'AGENT_FINISHED', { role: 'tester', deliverySha, ...result });
      const quota = quotaFailure(result);
      if (quota) {
        store.waitForQuota(task.id, action.kind, { retryAt: quotaRetryAt(quota, { ...(runtime.quota ?? {}), attempt: store.events(task.id).filter(event => event.type === 'QUOTA_WAIT_STARTED').length }), evidence: quota, maxTotalWaitMs: runtime.quota?.maxTotalWaitMs ?? 24 * 60 * 60_000 });
      } else {
        store.node(task.id, action.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { deliverySha, exitCode: result.exitCode, target: result.target });
        if (result.exitCode !== 0) store.transition(task.id, 'FIXING', { reason: 'AGENT_FAILED', role: 'tester' });
      }
      print({ action, ...result });
    } else if (action.kind === 'local-verify') {
      const remote = runtime.remotes.test; const worktree = joinRemotePath(remote, task.id);
      leaseWorktree(task, remote, worktree);
      const result = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: qualityCommand({ worktree, commands: project.commands, shellKind: remote.shellKind }), timeoutMs: 3600000 });
      store.event(task.id, 'QUALITY_COMMANDS_FINISHED', { worktree, ...result });
      store.node(task.id, action.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { exitCode: result.exitCode });
      if (result.exitCode !== 0) store.transition(task.id, 'FIXING', { reason: 'LOCAL_QUALITY_FAILED' });
      print({ action, ...result });
    } else if (action.kind === 'ci' || action.kind === 'e2e') {
      const sha = store.deliverySha(task.id); const requiredNames = action.kind === 'e2e' ? (runtime.workflows.e2eRequired ?? runtime.workflows.required) : runtime.workflows.required;
      if (action.kind === 'e2e' && runtime.workflows.e2eDispatch) {
        const dispatch = runtime.workflows.e2eDispatch;
        await dispatchWorkflow({ gh: runtime.gh, repository: task.repository, workflow: dispatch.workflow, ref: task.branch, fields: { ...(dispatch.inputs ?? {}), sha } });
        store.event(task.id, 'WORKFLOW_DISPATCHED', { ...dispatch, ref: task.branch, sha });
      }
      const result = await waitForRequiredRuns({ gh: runtime.gh, repository: task.repository, sha, branch: task.branch, requiredNames });
      for (const run of result.selected) store.workflow(task.id, sha, run);
      store.node(task.id, action.kind, result.passed ? 'SUCCEEDED' : result.failed.length || result.timedOut ? 'FAILED' : 'RUNNING', result);
      if (!result.passed) store.transition(task.id, result.failed.length ? 'FIXING' : 'BLOCKED_USER_DECISION', { reason: result.timedOut ? 'WORKFLOW_TIMEOUT' : 'WORKFLOW_FAILED', sha });
      print({ action, ...result });
    } else if (action.kind === 'rc-build') {
      const request = store.rcRequest(task.id); const sha = store.deliverySha(task.id); const rc = runtime.workflows.rc;
      store.node(task.id, action.kind, 'RUNNING', { version: request.version, sha, workflow: rc.workflow });
      store.transition(task.id, 'RC_BUILDING', { version: request.version, sha, workflow: rc.workflow });
      await dispatchWorkflow({ gh: runtime.gh, repository: task.repository, workflow: rc.workflow, ref: task.branch, fields: { ...(rc.inputs ?? {}), sha, version: request.version } });
      store.event(task.id, 'RC_WORKFLOW_DISPATCHED', { version: request.version, sha, branch: task.branch, workflow: rc.workflow });
      const result = await waitForRequiredRuns({ gh: runtime.gh, repository: task.repository, sha, branch: task.branch, requiredNames: rc.required });
      for (const run of result.selected) store.workflow(task.id, sha, run);
      if (result.passed) {
        const artifacts = [];
        for (const run of result.selected) {
          const directory = taskArtifactDirectory(join(home, 'artifacts', 'rc'), task.id, run.databaseId);
          const downloaded = await downloadRunArtifacts({ gh: runtime.gh, repository: task.repository, runId: run.databaseId, directory });
          const manifest = artifactManifest(directory);
          store.artifact(task.id, `rc-${request.version}-${run.databaseId}`, directory, manifest.sha256);
          artifacts.push({ ...downloaded, manifest });
        }
        store.event(task.id, 'RC_ARTIFACTS_RECORDED', { version: request.version, sha, artifacts });
      }
      store.node(task.id, action.kind, result.passed ? 'SUCCEEDED' : result.failed.length || result.timedOut ? 'FAILED' : 'RUNNING', { version: request.version, ...result });
      if (!result.passed) store.transition(task.id, result.failed.length ? 'FIXING' : 'BLOCKED_USER_DECISION', { reason: result.timedOut ? 'RC_WORKFLOW_TIMEOUT' : 'RC_WORKFLOW_FAILED', sha, version: request.version });
      print({ action, version: request.version, ...result });
    } else if (action.kind === 'rc') {
      const result = evaluateRcGate({ nodes: store.nodes(task.id), workflows: store.workflows(task.id) });
      store.event(task.id, 'RC_GATE_EVALUATED', result);
      store.node(task.id, 'rc', result.passed ? 'SUCCEEDED' : 'FAILED', result);
      store.transition(task.id, result.passed ? 'RC_READY' : 'BLOCKED_USER_DECISION', { gate: result });
      if (result.passed) {
        releaseWorktree(task, runtime.remotes.development, joinRemotePath(runtime.remotes.development, task.id));
        releaseWorktree(task, runtime.remotes.test, joinRemotePath(runtime.remotes.test, task.id));
      }
      print({ action, ...result });
    }
  } else if (command === 'task-run-all') {
    const id = required('id'); const project = required('project'); const maxSteps = Number(options['max-steps'] ?? 10);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) throw new Error('INVALID_MAX_STEPS');
    const taskLockHolder = `runner:${process.pid}:${randomUUID()}`;
    const taskLockKey = `task:${id}`;
    let taskLockLost = false;
    store.acquire(taskLockKey, taskLockHolder, 2 * 60_000);
    const taskLockHeartbeat = setInterval(() => {
      try { store.acquire(taskLockKey, taskLockHolder, 2 * 60_000); }
      catch (error) { taskLockLost = true; console.error(`TASK_LOCK_RENEWAL_FAILED:${error.message}`); }
    }, 30_000);
    taskLockHeartbeat.unref?.();
    try {
    const steps = [];
    const autoRelease = readProject(project).runtime?.release;
    const rcVersion = () => store.rcRequest(id).version.split('-rc.')[0];
    for (let step = 0; step < maxSteps; step += 1) {
      if (taskLockLost) throw new Error('TASK_LOCK_LOST');
      const currentState = store.get(id).state;
      if (currentState === 'RC_READY' && autoRelease?.autoAfterGate === true) {
        if (!autoRelease.unit || !Array.isArray(autoRelease.required) || autoRelease.required.length === 0) throw new Error('AUTO_RELEASE_CONFIG_INCOMPLETE');
        store.approveRelease(id, autoRelease.approvedBy, 'Approved baseline permits formal release after every configured gate passes.');
      }
      if (['RELEASE_APPROVED', 'RELEASE_TRIGGERED'].includes(store.get(id).state) && autoRelease?.autoAfterGate === true) {
        const releaseCommand = store.get(id).state === 'RELEASE_APPROVED' ? 'release-trigger' : 'release-wait';
        const releaseArgs = releaseCommand === 'release-trigger'
          ? [fileURLToPath(import.meta.url), releaseCommand, '--id', id, '--project', project, '--home', home, '--unit', autoRelease.unit, '--tag', rcVersion()]
          : [fileURLToPath(import.meta.url), releaseCommand, '--id', id, '--home', home, '--gh', runtimeConfig(readProject(project)).gh ?? 'gh', '--unit', autoRelease.unit, '--required', autoRelease.required.join(',')];
        const releaseResult = await runProcess(process.execPath, releaseArgs);
        steps.push({ releaseCommand, ...releaseResult });
        if (releaseResult.exitCode !== 0 || releaseCommand === 'release-wait') break;
        continue;
      }
      if (store.get(id).state === 'TEST_CASES_APPROVED') store.transition(id, 'IMPLEMENTING', { startedAt: new Date().toISOString() });
      if (!store.nodes(id).length) store.plan(id, ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build', 'rc']);
      const nodes = store.nodes(id);
      if (store.get(id).state === 'FIXING' && options['auto-retry'] === 'true') {
        const retry = store.retry(id, 'develop', retryKinds('develop', nodes));
        steps.push({ retry });
        if (!retry.allowed) break;
        continue;
      }
      const action = nextAction(nodes);
      if (!action) break;
      store.event(id, 'TASK_NODE_DISPATCHED', { kind: action.kind, dispatchedAt: new Date().toISOString() });
      const mirrorPath = project.runtime?.taskMirror?.remotePath;
      if (mirrorPath) {
        try {
          const mirror = await publishTaskSnapshot({ store, repository: project.repository, remote: runtimeConfig(project).remotes.development, remotePath: mirrorPath, remoteFinalPath: project.runtime?.taskMirror?.remoteFinalPath });
          store.event(id, 'TASK_MIRROR_UPDATED', mirror);
        } catch (error) {
          store.event(id, 'TASK_MIRROR_FAILED', { message: error instanceof Error ? error.message : String(error) });
        }
      }
      const child = await runProcess(process.execPath, [fileURLToPath(import.meta.url), 'task-run-next', '--id', id, '--project', project, '--home', home]);
      if (taskLockLost) throw new Error('TASK_LOCK_LOST');
      steps.push(child);
      store.event(id, 'TASK_NODE_FINISHED', { kind: action.kind, state: store.nodes(id).find(node => node.kind === action.kind)?.state ?? 'UNKNOWN', finishedAt: new Date().toISOString() });
      if (mirrorPath) {
        try {
          const mirror = await publishTaskSnapshot({ store, repository: project.repository, remote: runtimeConfig(project).remotes.development, remotePath: mirrorPath, remoteFinalPath: project.runtime?.taskMirror?.remoteFinalPath });
          store.event(id, 'TASK_MIRROR_UPDATED', mirror);
        } catch (error) {
          store.event(id, 'TASK_MIRROR_FAILED', { message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (child.exitCode !== 0) break;
      const current = store.get(id);
      if (['FIXING', 'WAITING_QUOTA', 'BLOCKED_USER_DECISION', 'RELEASED'].includes(current.state) || (['RC_READY', 'RELEASE_APPROVED', 'RELEASE_TRIGGERED'].includes(current.state) && autoRelease?.autoAfterGate !== true)) break;
    }
    print({ steps: steps.map(item => ({ exitCode: item.exitCode, stdout: item.stdout, stderr: item.stderr })), task: store.get(id), ready: nextNodes(store.nodes(id)) });
    } finally { clearInterval(taskLockHeartbeat); store.release(taskLockKey, taskLockHolder); }
  } else if (command === 'task-prepare-worktree') {
    const task = store.get(required('id')); const worktree = join(required('worktree-root'), task.id);
    store.node(task.id, 'prepare-worktree', 'RUNNING', { worktree });
    const result = await runLingxiCommand({ cli: required('lingxi-cli'), session: required('session'), command: worktreeCommand({ baseSha: task.baseSha, branch: task.branch, worktree, repositoryRoot: options['repository-root'], shellKind: options['shell-kind'] ?? 'posix' }) });
    store.event(task.id, 'WORKTREE_PREPARED', { worktree, ...result });
    store.node(task.id, 'prepare-worktree', result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { worktree, exitCode: result.exitCode });
    if (result.exitCode !== 0) store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'WORKTREE_PREPARE_FAILED' });
    print({ worktree, ...result });
  } else if (command === 'task-quality-run') {
    const task = store.get(required('id')); const project = readProject(required('project')); const worktree = required('worktree');
    store.transition(task.id, 'LOCAL_VERIFYING', { worktree }); store.node(task.id, 'local-verify', 'RUNNING', { worktree, commands: project.commands });
    const result = await runLingxiCommand({ cli: required('lingxi-cli'), session: required('session'), command: qualityCommand({ worktree, commands: project.commands, shellKind: options['shell-kind'] ?? 'posix' }), timeoutMs: Number(options['timeout-ms'] ?? 3600000) });
    store.event(task.id, 'QUALITY_COMMANDS_FINISHED', { worktree, commands: project.commands, ...result });
    store.node(task.id, 'local-verify', result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { exitCode: result.exitCode });
    if (result.exitCode !== 0) store.transition(task.id, 'FIXING', { reason: 'LOCAL_QUALITY_FAILED' });
    print(result);
  } else if (command === 'task-git-verify') {
    const task = store.get(required('id')); const worktree = required('worktree');
    const result = await runLingxiCommand({ cli: required('lingxi-cli'), session: required('session'), command: verificationCommand(worktree, task.branch, options['shell-kind'] ?? 'posix') });
    if (result.exitCode !== 0) throw new Error('GIT_VERIFICATION_COMMAND_FAILED');
    const remote = decodeLingxiResult(result.stdout); const branchSha = await getBranchSha({ gh: options.gh, repository: task.repository, branch: task.branch }); const evidence = parseVerification(remote.stdout ?? '', branchSha);
    store.event(task.id, 'GIT_VERIFIED', { worktree, ...evidence });
    store.node(task.id, 'git-verify', evidence.clean ? 'SUCCEEDED' : 'FAILED', { worktree, ...evidence });
    if (!evidence.clean) store.transition(task.id, 'FIXING', { reason: 'GIT_WORKTREE_DIRTY', worktree });
    print(evidence);
  } else if (command === 'task-remote-exec') {
    const task = store.get(required('id'));
    store.transition(task.id, options.state ?? 'IMPLEMENTING', { executor: 'lingxi-cli', session: required('session') });
    const result = await runLingxiCommand({ cli: required('lingxi-cli'), session: options.session, command: required('remote-command') });
    store.event(task.id, 'REMOTE_COMMAND_FINISHED', { command: options['remote-command'], ...result });
    if (options.kind) store.node(task.id, options.kind, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', { exitCode: result.exitCode });
    if (result.exitCode !== 0) store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'REMOTE_COMMAND_FAILED', exitCode: result.exitCode });
    print(result);
  } else if (command === 'workflow-dispatch') {
    const task = store.get(required('id'));
    const fields = options['input-key'] ? { [options['input-key']]: required('input-value') } : {};
    const result = await dispatchWorkflow({ gh: options.gh, repository: task.repository, workflow: required('workflow'), ref: options.sha ?? store.deliverySha(task.id), fields });
    store.event(task.id, 'WORKFLOW_DISPATCHED', result); print(result);
  } else if (command === 'workflow-sync') {
    const task = store.get(required('id')); const sha = options.sha ?? store.deliverySha(task.id);
    const kind = options.kind ?? 'ci';
    if (!['ci', 'e2e'].includes(kind)) throw new Error('INVALID_WORKFLOW_NODE_KIND');
    const requiredNames = required('required').split(',').filter(Boolean);
    const result = await waitForRequiredRuns({ gh: options.gh, repository: task.repository, sha, branch: kind === 'e2e' ? task.branch : undefined, requiredNames, timeoutMs: 1, intervalMs: 1 });
    for (const run of result.selected) store.workflow(task.id, sha, run);
    store.node(task.id, kind, result.passed ? 'SUCCEEDED' : result.failed.length ? 'FAILED' : 'RUNNING', result);
    if (result.failed.length) store.transition(task.id, 'FIXING', { reason: 'WORKFLOW_FAILED', sha });
    print(result);
  } else if (command === 'workflow-wait') {
    const task = store.get(required('id')); const sha = options.sha ?? store.deliverySha(task.id);
    const requiredNames = required('required').split(',').filter(Boolean);
    const result = await waitForRequiredRuns({ gh: options.gh, repository: task.repository, sha, requiredNames, timeoutMs: Number(options['timeout-ms'] ?? 1800000), intervalMs: Number(options['interval-ms'] ?? 10000) });
    for (const run of result.selected) store.workflow(task.id, sha, run);
    store.node(task.id, 'ci', result.passed ? 'SUCCEEDED' : result.failed.length || result.timedOut ? 'FAILED' : 'RUNNING', result);
    if (!result.passed) store.transition(task.id, result.failed.length ? 'FIXING' : 'BLOCKED_USER_DECISION', { reason: result.timedOut ? 'WORKFLOW_TIMEOUT' : 'WORKFLOW_FAILED', sha });
    print(result);
  } else if (command === 'workflow-download-artifacts') {
    const task = store.get(required('id')); const runId = required('run-id'); const sha = store.deliverySha(task.id);
    const run = store.workflows(task.id).find(item => item.runId === String(runId) && item.sha === sha);
    if (!run) throw new Error('WORKFLOW_RUN_NOT_RECORDED_FOR_DELIVERY_SHA');
    if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('WORKFLOW_RUN_NOT_SUCCESSFUL');
    const directory = options.directory ? resolve(options.directory) : taskArtifactDirectory(join(home, 'artifacts'), task.id, runId);
    const downloaded = await downloadRunArtifacts({ gh: options.gh, repository: task.repository, runId, directory });
    const manifest = artifactManifest(directory);
    store.artifact(task.id, `github-actions-run-${runId}`, directory, manifest.sha256);
    store.event(task.id, 'WORKFLOW_ARTIFACTS_DOWNLOADED', { sha, workflow: run.name, ...downloaded, manifest });
    print({ ...downloaded, manifest });
  } else if (command === 'rc-evaluate') {
    const task = store.get(required('id'));
    const result = evaluateRcGate({ nodes: store.nodes(task.id), workflows: store.workflows(task.id) });
    store.event(task.id, 'RC_GATE_EVALUATED', result);
    if (result.passed) store.transition(task.id, 'RC_READY', { gate: result });
    else store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'RC_GATE_INCOMPLETE', gate: result });
    print(result);
  } else if (command === 'release-approve') {
    store.approveRelease(required('id'), required('approved-by'), options.note ?? '');
    print(store.get(options.id));
  } else if (command === 'release-trigger') {
    const task = store.get(required('id')); const project = readProject(required('project')); const runtime = runtimeConfig(project);
    const unit = required('unit'); const tag = required('tag');
    if (task.state !== 'RELEASE_APPROVED') throw new Error('RELEASE_TRIGGER_REQUIRES_APPROVAL');
    if (!validFormalTag(unit, tag)) throw new Error('INVALID_FORMAL_RELEASE_TAG');
    const sha = store.deliverySha(task.id); const remote = runtime.remotes.development; const worktree = joinRemotePath(remote, task.id);
    const lock = store.acquire(`release:${task.repository}:${unit}`, task.id, 7200000);
    const controller = await runLingxiCommand({ cli: remote.lingxiCli, session: remote.session, command: formalTagCommand({ worktree, sha, tag, shellKind: remote.shellKind }) });
    let remoteResult;
    try { remoteResult = controller.exitCode === 0 ? decodeLingxiResult(controller.stdout) : controller; } catch { remoteResult = controller; }
    const exitCode = remoteResult.exitCode ?? controller.exitCode;
    store.event(task.id, 'FORMAL_RELEASE_TAG_ATTEMPTED', { unit, tag, sha, lock, exitCode, stdout: remoteResult.stdout ?? controller.stdout, stderr: remoteResult.stderr ?? controller.stderr });
    if (exitCode !== 0) {
      store.release(lock.key, task.id);
      store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'FORMAL_RELEASE_TAG_FAILED_OR_UNKNOWN', unit, tag, sha });
      print({ unit, tag, sha, ...remoteResult });
    } else {
      store.transition(task.id, 'RELEASE_TRIGGERED', { unit, tag, sha, lock: lock.key });
      print({ unit, tag, sha, status: 'RELEASE_TRIGGERED' });
    }
  } else if (command === 'release-wait') {
    const task = store.get(required('id')); const unit = required('unit'); const requiredNames = required('required').split(',').filter(Boolean);
    if (task.state !== 'RELEASE_TRIGGERED') throw new Error('RELEASE_WAIT_REQUIRES_TRIGGERED_RELEASE');
    const sha = store.deliverySha(task.id);
    const releaseEvent = [...store.events(task.id)].reverse().find(event => event.type === 'STATE_CHANGED' && event.data?.state === 'RELEASE_TRIGGERED');
    const tag = releaseEvent?.data?.tag;
    if (!tag || !validFormalTag(unit, tag)) {
      store.release(`release:${task.repository}:${unit}`, task.id);
      store.transition(task.id, 'BLOCKED_USER_DECISION', { reason: 'FORMAL_RELEASE_TAG_NOT_RECORDED', unit, sha });
      print({ unit, sha, status: 'BLOCKED_USER_DECISION', reason: 'FORMAL_RELEASE_TAG_NOT_RECORDED' });
    } else {
      const timeoutMs = Number(options['timeout-ms'] ?? 1800000);
      const intervalMs = Number(options['interval-ms'] ?? 10000);
      const workflowResult = await waitForRequiredRuns({ gh: options.gh, repository: task.repository, sha, requiredNames, timeoutMs, intervalMs });
      for (const run of workflowResult.selected) store.workflow(task.id, sha, run);
      const releaseResult = workflowResult.passed
        ? await waitForRelease({ gh: options.gh, repository: task.repository, tag, timeoutMs, intervalMs })
        : { found: false, tag, lastError: 'REQUIRED_RELEASE_WORKFLOW_FAILED', timedOut: workflowResult.timedOut };
      if (workflowResult.passed && releaseResult.found) {
        store.transition(task.id, 'RELEASED', { unit, tag, sha, releaseUrl: releaseResult.url, workflows: workflowResult.selected.map(run => run.databaseId) });
        store.release(`release:${task.repository}:${unit}`, task.id);
      } else {
        store.release(`release:${task.repository}:${unit}`, task.id);
        const reason = workflowResult.passed ? (releaseResult.timedOut ? 'FORMAL_RELEASE_TIMEOUT' : 'FORMAL_RELEASE_NOT_VERIFIED') : workflowResult.timedOut ? 'FORMAL_RELEASE_TIMEOUT' : 'FORMAL_RELEASE_FAILED';
        store.transition(task.id, 'BLOCKED_USER_DECISION', { reason, unit, tag, sha, workflows: workflowResult.selected.map(run => run.databaseId), release: releaseResult });
      }
      print({ unit, tag, sha, workflows: workflowResult, release: releaseResult });
    }
  } else if (command === 'rc-request') {
    print(store.requestRc(required('id'), required('version')));
  } else if (command === 'task-retry') {
    const id = required('id'); const nodes = store.nodes(id); const from = required('from');
    print(store.retry(id, from, retryKinds(from, nodes)));
  } else if (command === 'recover') print({ blockedTasks: store.recover() });
  else if (!command || command === 'help') {
    process.stdout.write('lingxi-orchestrator init | task-create ... | task-list | task-show --id ID | task-plan --id ID | task-mirror --id ID --project project.json | node-transition --id ID --kind KIND --state STATE | artifact-record --id ID --kind KIND --location URL_OR_PATH [--sha SHA] | task-prompt --id ID --project project.json | task-remote-exec ... | workflow-dispatch --id ID --workflow FILE [--sha SHA] | workflow-sync --id ID --required "CI,Real UI" [--sha SHA] | task-transition --id ID --state STATE | recover\n');
  } else throw new Error('UNKNOWN_COMMAND');
} finally { store.close(); }
