import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

export async function listRunsForSha({ gh = 'gh', repository, sha }) {
  const result = await run(gh, ['run', 'list', '--repo', repository, '--commit', sha, '--limit', '100', '--json', 'databaseId,name,status,conclusion,url,headSha'], undefined);
  if (result.exitCode !== 0) throw new Error(`GITHUB_RUN_LIST_FAILED: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

export function runCheckedOutSha(log, sha) {
  const escaped = sha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:ref: ${escaped}|git checkout --progress --force ${escaped})(?:\\s|$)`, 'm').test(log);
}

async function listRunsForBranch({ gh, repository, branch }) {
  const result = await run(gh, ['run', 'list', '--repo', repository, '--branch', branch, '--limit', '100', '--json', 'databaseId,name,status,conclusion,url,headSha'], undefined);
  if (result.exitCode !== 0) throw new Error(`GITHUB_BRANCH_RUN_LIST_FAILED: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

async function verifyRunCheckout({ gh, repository, runId, sha }) {
  const result = await run(gh, ['run', 'view', String(runId), '--repo', repository, '--log'], undefined);
  return result.exitCode === 0 && runCheckedOutSha(result.stdout, sha);
}

export async function getBranchSha({ gh = 'gh', repository, branch }) {
  const ref = encodeURIComponent(`heads/${branch}`);
  const result = await run(gh, ['api', `repos/${repository}/git/ref/${ref}`, '--jq', '.object.sha'], undefined);
  if (result.exitCode !== 0) throw new Error(`GITHUB_BRANCH_LOOKUP_FAILED: ${result.stderr.trim()}`);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('GITHUB_BRANCH_SHA_INVALID');
  return sha;
}

export async function dispatchWorkflow({ gh = 'gh', repository, workflow, ref, fields = {} }) {
  const args = ['workflow', 'run', workflow, '--repo', repository, '--ref', ref];
  for (const [key, value] of Object.entries(fields)) args.push('--field', `${key}=${value}`);
  const result = await run(gh, args, undefined);
  if (result.exitCode !== 0) throw new Error(`GITHUB_WORKFLOW_DISPATCH_FAILED: ${result.stderr.trim()}`);
  return { workflow, ref, fields };
}

export function artifactDownloadArgs({ repository, runId, directory }) {
  if (!repository || !String(runId) || !directory) throw new Error('ARTIFACT_DOWNLOAD_CONFIGURATION_MISSING');
  return ['run', 'download', String(runId), '--repo', repository, '--dir', directory];
}

export async function downloadRunArtifacts({ gh = 'gh', repository, runId, directory }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = await run(gh, artifactDownloadArgs({ repository, runId, directory }), undefined);
  if (result.exitCode !== 0) throw new Error(`GITHUB_ARTIFACT_DOWNLOAD_FAILED: ${result.stderr.trim()}`);
  return { runId: String(runId), directory, stdout: result.stdout };
}

export function classifyRuns(runs, requiredNames) {
  const selected = runs.filter(run => requiredNames.includes(run.name));
  const missing = requiredNames.filter(name => !selected.some(run => run.name === name));
  const pending = selected.filter(run => !['completed'].includes(run.status));
  const failed = selected.filter(run => run.status === 'completed' && run.conclusion !== 'success');
  return { selected, missing, pending, failed, passed: missing.length === 0 && pending.length === 0 && failed.length === 0 };
}

export async function waitForRequiredRuns({ gh = 'gh', repository, sha, branch, requiredNames, timeoutMs = 1800000, intervalMs = 10000 }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const exactRuns = await listRunsForSha({ gh, repository, sha });
    const branchRuns = branch ? await listRunsForBranch({ gh, repository, branch }) : [];
    const candidates = [...new Map([...exactRuns, ...branchRuns].map(item => [String(item.databaseId), item])).values()];
    const runs = [];
    for (const candidate of candidates) {
      if (candidate.headSha === sha) runs.push(candidate);
      else if (candidate.name && requiredNames.includes(candidate.name) && await verifyRunCheckout({ gh, repository, runId: candidate.databaseId, sha })) {
        runs.push({ ...candidate, headSha: sha, reportedHeadSha: candidate.headSha });
      }
    }
    const result = classifyRuns(runs, requiredNames);
    if (result.passed || result.failed.length || Date.now() >= deadline) return { ...result, timedOut: !result.passed && !result.failed.length && Date.now() >= deadline };
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
