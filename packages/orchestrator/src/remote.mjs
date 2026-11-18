import { spawn } from 'node:child_process';

export function runLingxiCommand({ node = process.execPath, cli, session, command, timeoutMs }) {
  if (!cli || !session || !command) throw new Error('REMOTE_EXECUTOR_CONFIGURATION_MISSING');
  return new Promise((resolve, reject) => {
    const args = [cli, 'exec', '--session', session, '--command', command];
    if (timeoutMs !== undefined) args.push('--timeout', String(timeoutMs));
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

export function runLingxiUpload({ node = process.execPath, cli, session, localPath, remotePath }) {
  if (!cli || !session || !localPath || !remotePath) throw new Error('REMOTE_UPLOAD_CONFIGURATION_MISSING');
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, 'upload', '--session', session, '--local', localPath, '--path', remotePath, '--overwrite', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

export function decodeLingxiResult(output) {
  const text = output.trim();
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try {
      const parsed = JSON.parse(text.slice(index));
      if (parsed && typeof parsed === 'object') {
        const commandOutput = text.slice(0, index).trimEnd();
        return parsed.event === 'result' && typeof parsed.status === 'string'
          ? { ...parsed, stdout: parsed.stdout ?? commandOutput }
          : parsed;
      }
    } catch {}
  }
  throw new Error('LINGXI_RESULT_UNPARSEABLE');
}
