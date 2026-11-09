import { createServer } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

// The bridge deliberately owns the real MCP server outside the AI sandbox.
// The sandbox receives only a Unix socket and never the pairing profile.
export async function startAiBridge({ socketPath, node, cli, home, session }) {
  await rm(socketPath, { force: true });
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const children = new Set();
  const server = createServer(socket => {
    const child = spawn(node, [cli, 'serve', '--home', home, '--session', session], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    child.stderr.on('data', data => process.stderr.write(data));
    const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
    socket.once('close', stop); socket.once('error', stop);
    child.once('exit', () => { children.delete(child); socket.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return {
    async close() {
      for (const child of children) child.kill('SIGTERM');
      await new Promise(resolve => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}
