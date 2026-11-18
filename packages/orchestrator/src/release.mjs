import { powershellCommand } from './shell.mjs';

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function validFormalTag(unit, tag) {
  if (unit === 'obsidian-plugin') return /^\d+\.\d+\.\d+$/.test(tag);
  if (unit === 'remote') return /^remote-\d+\.\d+\.\d+$/.test(tag);
  return false;
}

export function formalTagCommand({ worktree, sha, tag, shellKind = 'posix' }) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('INVALID_DELIVERY_SHA');
  if (shellKind === 'cmd') {
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const script = [
      `$head = & git -C ${literal(worktree)} rev-parse HEAD`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `if ($head -ne ${literal(sha)}) { Write-Error 'DELIVERY_SHA_MISMATCH'; exit 1 }`,
      `& git -c http.version=HTTP/1.1 -c http.proxy= -C ${literal(worktree)} ls-remote --exit-code --tags origin ${literal(`refs/tags/${tag}`)} *> $null`,
      'if ($LASTEXITCODE -eq 0) { Write-Error "TAG_ALREADY_EXISTS"; exit 42 }',
      `& git -C ${literal(worktree)} tag -a ${literal(tag)} ${literal(sha)} -m ${literal(`Release ${tag}`)}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `& git -c http.version=HTTP/1.1 -c http.proxy= -C ${literal(worktree)} push origin ${literal(`refs/tags/${tag}`)}`,
      'exit $LASTEXITCODE'
    ].join('; ');
    return powershellCommand(script);
  }
  return [
    'set -e',
    `test "$(git -C ${quote(worktree)} rev-parse HEAD)" = ${quote(sha)}`,
    `if git -C ${quote(worktree)} ls-remote --exit-code --tags origin ${quote(`refs/tags/${tag}`)} >/dev/null 2>&1; then echo TAG_ALREADY_EXISTS >&2; exit 42; fi`,
    `git -C ${quote(worktree)} tag -a ${quote(tag)} ${quote(sha)} -m ${quote(`Release ${tag}`)}`,
    `git -C ${quote(worktree)} push origin ${quote(`refs/tags/${tag}`)}`
  ].join('; ');
}
