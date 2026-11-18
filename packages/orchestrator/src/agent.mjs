import { spawn } from 'node:child_process';
import { powershellCommand, powershellLiteral } from './shell.mjs';

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function agentConfigArgs(agent) {
  const args = [...(agent.args ?? [])];
  if (!agent.mcp) return args;
  const { name, command, serverArgs = [], defaultToolsApprovalMode } = agent.mcp;
  if (!/^[a-zA-Z0-9_-]+$/.test(name ?? '') || !command || !Array.isArray(serverArgs)) throw new Error('INVALID_AGENT_MCP_CONFIG');
  const overrides = [
    '-c', `mcp_servers.${name}.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.${name}.args=${JSON.stringify(serverArgs)}`,
    '-c', `mcp_servers.${name}.enabled=true`,
    '-c', `mcp_servers.${name}.required=true`,
    '-c', `mcp_servers.${name}.startup_timeout_sec=30`
  ];
  if (defaultToolsApprovalMode) overrides.push('-c', `mcp_servers.${name}.default_tools_approval_mode=${JSON.stringify(defaultToolsApprovalMode)}`);
  const promptIndex = args.lastIndexOf('-');
  if (promptIndex < 0) return [...args, ...overrides];
  return [...args.slice(0, promptIndex), ...overrides, ...args.slice(promptIndex)];
}

export function remoteAgentCommand({ executable, args = [], prompt, worktree, shellKind = 'posix' }) {
  if (!executable) throw new Error('AGENT_EXECUTABLE_MISSING');
  if (!Array.isArray(args)) throw new Error('AGENT_ARGS_MUST_BE_ARRAY');
  if (!worktree) throw new Error('AGENT_WORKTREE_MISSING');
  if (shellKind === 'cmd') {
    const promptBase64 = Buffer.from(`${JSON.stringify(prompt, null, 2)}\n`, 'utf8').toString('base64');
    const argumentList = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const script = `$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${promptBase64}')); $agentArgs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${argumentList}')) | ConvertFrom-Json; Set-Location -LiteralPath ${powershellLiteral(worktree)}; $prompt | & ${powershellLiteral(executable)} @agentArgs; exit $LASTEXITCODE`;
    return powershellCommand(script);
  }
  const encodedPrompt = Buffer.from(`${JSON.stringify(prompt, null, 2)}\n`).toString('base64');
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(' ');
  return `set -e; cd ${shellQuote(worktree)}; printf %s ${shellQuote(encodedPrompt)} | base64 -d | ${command}`;
}

export function runAgent({ executable, args = [], prompt, mcp }) {
  if (!executable) throw new Error('AGENT_EXECUTABLE_MISSING');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, agentConfigArgs({ args, mcp }), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(prompt, null, 2)}\n`);
  });
}
