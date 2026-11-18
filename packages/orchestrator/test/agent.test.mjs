import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConfigArgs, remoteAgentCommand } from '../src/agent.mjs';

test('adds a task-scoped LingXi MCP override without changing Codex user configuration', () => {
  const args = agentConfigArgs({ args: ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--ephemeral', '-'], mcp: { name: 'lingxi-demo', command: '/usr/bin/node', serverArgs: ['/lingxi/cli.mjs', 'serve', '--session', 'session-1'], defaultToolsApprovalMode: 'approve' } });
  assert.deepEqual(args.slice(0, 6), ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--ephemeral', '-c']);
  assert.ok(args.includes('mcp_servers.lingxi-demo.command="/usr/bin/node"'));
  assert.ok(args.includes('mcp_servers.lingxi-demo.args=["/lingxi/cli.mjs","serve","--session","session-1"]'));
  assert.ok(args.includes('mcp_servers.lingxi-demo.required=true'));
  assert.ok(args.includes('mcp_servers.lingxi-demo.startup_timeout_sec=30'));
  assert.ok(args.includes('mcp_servers.lingxi-demo.default_tools_approval_mode="approve"'));
  assert.equal(args.at(-1), '-');
});

test('creates a quoted remote AI command with the immutable prompt on stdin', () => {
  const command = remoteAgentCommand({ executable: 'codex', args: ['exec', '-'], prompt: { taskId: 'RND-1' }, worktree: '/worktrees/RND-1' });
  assert.match(command, /^set -e; cd '\/worktrees\/RND-1';/);
  assert.match(command, /base64 -d \| 'codex' 'exec' '-'/);
  const encoded = command.match(/printf %s '([^']+)'/)?.[1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '{\n  "taskId": "RND-1"\n}\n');
});

test('encodes Windows remote agent prompts without shell interpolation', () => {
  const command = remoteAgentCommand({ executable: 'codex', args: ['exec', '-'], prompt: { taskId: '安全-1' }, worktree: 'D:\\work trees\\安全-1', shellKind: 'cmd' });
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /Set-Location -LiteralPath 'D:\\work trees\\安全-1'/);
  assert.match(script, /安全-1/);
  assert.match(script, /& 'codex' @agentArgs/);
});
