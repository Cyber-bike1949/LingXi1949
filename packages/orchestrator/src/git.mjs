import { powershellCommand, powershellLiteral } from './shell.mjs';

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function verificationCommand(worktree, branch, shellKind = 'posix') {
  if (shellKind === 'cmd') {
    const script = [
      `$head = & git -C ${powershellLiteral(worktree)} rev-parse HEAD`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      "Write-Output ('HEAD:' + $head)",
      `& git -C ${powershellLiteral(worktree)} status --porcelain | ForEach-Object { Write-Output ('DIRTY:' + $_) }`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'exit 0'
    ].join('; ');
    return powershellCommand(script);
  }
  return `set -e; printf 'HEAD:%s\\n' "$(git -C ${quote(worktree)} rev-parse HEAD)"; git -C ${quote(worktree)} status --porcelain | sed 's/^/DIRTY:/'`;
}

export function parseVerification(stdout, expectedRemoteSha) {
  const lines = stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  const sha = lines.find(line => line.startsWith('HEAD:'))?.slice(5);
  const remoteSha = expectedRemoteSha ?? lines.find(line => line.startsWith('REMOTE:'))?.slice(7);
  const dirty = lines.filter(line => line.startsWith('DIRTY:')).map(line => line.slice(6));
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) throw new Error('INVALID_GIT_SHA');
  if (!/^[0-9a-f]{40}$/i.test(remoteSha ?? '')) throw new Error('INVALID_REMOTE_GIT_SHA');
  if (remoteSha !== sha) throw new Error('GIT_BRANCH_NOT_PUSHED');
  return { sha, clean: dirty.length === 0, dirty };
}
