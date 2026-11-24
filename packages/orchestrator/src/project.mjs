import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { validateDockerSandbox } from './dockerSandbox.mjs';

export function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

export function joinRemotePath(remote, ...segments) {
  const windows = remote.shellKind === 'cmd' || remote.shell?.toLowerCase().endsWith('cmd.exe') || /^[A-Za-z]:\\|^\\\\/.test(remote.worktreeRoot);
  return (windows ? win32 : posix).join(remote.worktreeRoot, ...segments);
}

export function readProject(path) {
  const project = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['repository', 'developmentBranchPattern', 'commands']) if (!project[key]) throw new Error(`PROJECT_CONFIG_MISSING_${key.toUpperCase()}`);
  if (!Array.isArray(project.commands)) throw new Error('PROJECT_CONFIG_COMMANDS_MUST_BE_ARRAY');
  return project;
}

export function taskPrompt(task, role, project, documents) {
  if (!documents?.requirementContent || !documents?.testCaseContent) throw new Error('APPROVED_DOCUMENT_CONTENT_REQUIRED');
  if (createHash('sha256').update(documents.requirementContent).digest('hex') !== task.requirementHash) throw new Error('APPROVED_REQUIREMENT_HASH_MISMATCH');
  if (createHash('sha256').update(documents.testCaseContent).digest('hex') !== task.testCaseHash) throw new Error('APPROVED_TEST_CASE_HASH_MISMATCH');
  return { taskId: task.id, role, repository: task.repository, branch: task.branch, baseSha: task.baseSha, inputContract: { requirementHash: task.requirementHash, testCaseHash: task.testCaseHash }, approvedDocuments: { requirement: documents.requirementContent, testCases: documents.testCaseContent }, requiredCommands: project.commands, requiredOutput: ['commitSha', 'testResults', 'Lingxi taskId', 'handoffReport'], gitInstructions: ['Work only on the assigned branch.', 'Run the required commands and fix failures.', 'Create a commit for the completed change.', 'Push the assigned branch to origin without force-pushing.'], prohibited: ['change acceptance criteria', 'force push', 'create release tag'], compatibility: 'Do not modify or replace existing LingXi manual control or AI CLI bindings.' };
}

export function runtimeConfig(project) {
  const runtime = project.runtime;
  validateDockerSandbox(runtime?.sandbox);
  if (runtime?.release?.autoAfterGate === true && (typeof runtime.release.approvedBy !== 'string' || !runtime.release.approvedBy.trim())) throw new Error('AUTO_RELEASE_APPROVER_REQUIRED');
  if (runtime?.quota !== undefined) {
    if (!runtime.quota || typeof runtime.quota !== 'object' || Array.isArray(runtime.quota)) throw new Error('PROJECT_RUNTIME_QUOTA_INVALID');
    const { defaultWaitMs = 30 * 60_000, maxWaitMs = 2 * 60 * 60_000, maxTotalWaitMs = 24 * 60 * 60_000 } = runtime.quota;
    for (const [name, value] of Object.entries({ defaultWaitMs, maxWaitMs, maxTotalWaitMs })) {
      if (!Number.isSafeInteger(value) || value < 60_000) throw new Error(`PROJECT_RUNTIME_QUOTA_${name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}_INVALID`);
    }
    if (defaultWaitMs > maxWaitMs || maxWaitMs > maxTotalWaitMs) throw new Error('PROJECT_RUNTIME_QUOTA_INTERVALS_INVALID');
  }
  const developmentRemote = runtime?.remotes?.development ?? runtime?.remote;
  const testRemote = runtime?.remotes?.test ?? (developmentRemote && { ...developmentRemote, worktreeRoot: joinRemotePath(developmentRemote, 'test') });
  for (const remote of [developmentRemote, testRemote]) if (!remote?.lingxiCli || !remote.session || !remote.worktreeRoot) throw new Error('PROJECT_RUNTIME_REMOTE_REQUIRED');
  const resource = remote => remote.resourceId ?? remote.session;
  if (resource(developmentRemote) === resource(testRemote) && developmentRemote.worktreeRoot === testRemote.worktreeRoot) throw new Error('PROJECT_RUNTIME_WORKTREE_ROOT_COLLISION');
  if (!runtime.agent?.executable || !Array.isArray(runtime.agent.args)) throw new Error('PROJECT_RUNTIME_AGENT_REQUIRED');
  if (!Array.isArray(runtime.workflows?.required)) throw new Error('PROJECT_RUNTIME_WORKFLOWS_REQUIRED');
  if (!runtime.workflows?.rc?.workflow || !Array.isArray(runtime.workflows.rc.required)) throw new Error('PROJECT_RUNTIME_RC_WORKFLOW_REQUIRED');
  const normalizeRemote = remote => ({ ...remote, shellKind: remote.shellKind ?? (remote.shell?.toLowerCase().endsWith('cmd.exe') ? 'cmd' : 'posix') });
  const normalizeAgent = agent => {
    if (!agent?.executable || !Array.isArray(agent.args)) throw new Error('PROJECT_RUNTIME_TESTER_REQUIRED');
    const target = agent.target ?? 'local';
    if (agent.resumeArgs !== undefined && (!Array.isArray(agent.resumeArgs) || agent.resumeArgs.some(argument => typeof argument !== 'string'))) throw new Error('PROJECT_RUNTIME_AGENT_RESUME_ARGS_INVALID');
    if (agent.resumeNativeSession === true && (!Array.isArray(agent.resumeArgs) || !agent.resumeArgs.some(argument => argument.includes('{sessionId}')))) throw new Error('PROJECT_RUNTIME_AGENT_RESUME_ARGS_REQUIRED');
    if (agent.resumeNativeSession === true && [...agent.args, ...(agent.resumeArgs ?? [])].some(argument => argument === '--ephemeral')) throw new Error('NATIVE_SESSION_RESUME_INCOMPATIBLE_WITH_EPHEMERAL');
    if (!['local', 'remote'].includes(target)) throw new Error('PROJECT_RUNTIME_AGENT_TARGET_INVALID');
    if (target === 'remote' && agent.executable.toLowerCase().includes('codex')) throw new Error('CODEX_MUST_RUN_ON_CONTROLLER');
    if (agent.mcp && (!agent.mcp.name || !agent.mcp.command || !Array.isArray(agent.mcp.serverArgs))) throw new Error('PROJECT_RUNTIME_AGENT_MCP_INVALID');
    return { ...agent, target };
  };
  const normalizedDevelopment = normalizeRemote(developmentRemote); const normalizedTest = normalizeRemote(testRemote);
  const agent = normalizeAgent(runtime.agent);
  const tester = normalizeAgent(runtime.tester ?? runtime.agent);
  if (runtime.sandbox?.enabled === true && [agent, tester].some(role =>
    role.target !== 'local' || !role.mcp || !/(?:^|\/)codex$/.test(role.executable))) {
    throw new Error('DOCKER_SANDBOX_REQUIRES_LOCAL_CODEX_WITH_LINGXI_MCP');
  }
  return { ...runtime, remote: normalizedDevelopment, remotes: { development: normalizedDevelopment, test: normalizedTest }, agent, tester };
}
