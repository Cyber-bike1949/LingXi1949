import { powershellCommand } from './shell.mjs';

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function validFormalTag(unit, tag) {
  if (unit === 'obsidian-plugin') return /^\d+\.\d+\.\d+$/.test(tag);
  if (unit === 'remote') return /^remote-\d+\.\d+\.\d+$/.test(tag);
  return false;
}

export function formalTagCommand({ worktree, sha, tag, shellKind = 'posix' }) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('INVALID_DELIVERY_SHA');
  const tagRef = `refs/tags/${tag}`;
  const peeledRef = `${tagRef}^{}`;
  if (shellKind === 'cmd') {
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const script = [
      `$head = & git -C ${literal(worktree)} rev-parse HEAD`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `if ($head -ne ${literal(sha)}) { Write-Error 'DELIVERY_SHA_MISMATCH'; exit 1 }`,
      `$refs = @(& git -c http.version=HTTP/1.1 -c http.proxy= -C ${literal(worktree)} ls-remote origin ${literal(tagRef)} ${literal(peeledRef)})`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      '$remoteTarget = $null',
      `foreach ($line in $refs) { $parts = $line -split '\\s+'; if ($parts.Count -ge 2 -and $parts[1] -eq '${peeledRef}') { $remoteTarget = $parts[0] } elseif ($parts.Count -ge 2 -and $parts[1] -eq '${tagRef}' -and -not $remoteTarget) { $remoteTarget = $parts[0] } }`,
      `if ($remoteTarget) { if ($remoteTarget -eq ${literal(sha)}) { Write-Output 'TAG_ALREADY_EXISTS_MATCHING_SHA'; exit 0 } else { Write-Error 'TAG_ALREADY_EXISTS_DIFFERENT_SHA'; exit 42 } }`,
      `$localTarget = & git -C ${literal(worktree)} rev-list -n 1 ${literal(tagRef)} 2>$null`,
      `if ($LASTEXITCODE -eq 0) { if ($localTarget -ne ${literal(sha)}) { Write-Error 'LOCAL_TAG_SHA_MISMATCH'; exit 42 }; & git -c http.version=HTTP/1.1 -c http.proxy= -C ${literal(worktree)} push origin ${literal(tagRef)}; exit $LASTEXITCODE }`,
      `& git -C ${literal(worktree)} tag -a ${literal(tag)} ${literal(sha)} -m ${literal(`Release ${tag}`)}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `& git -c http.version=HTTP/1.1 -c http.proxy= -C ${literal(worktree)} push origin ${literal(tagRef)}`,
      'exit $LASTEXITCODE'
    ].join('; ');
    return powershellCommand(script);
  }
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
    'set -e',
    `test "$(git -C ${quote(worktree)} rev-parse HEAD)" = ${quote(sha)}`,
    `remote_refs=$(git -C ${quote(worktree)} ls-remote origin ${quote(tagRef)} ${quote(peeledRef)})`,
    `remote_target=$(printf '%s\\n' "$remote_refs" | awk -v direct_ref=${quote(tagRef)} -v peeled_ref=${quote(peeledRef)} '$2 == peeled_ref { peeled=$1 } $2 == direct_ref { direct=$1 } END { if (peeled != "") print peeled; else print direct }')`,
    `if [ -n "$remote_target" ]; then if [ "$remote_target" = ${quote(sha)} ]; then echo TAG_ALREADY_EXISTS_MATCHING_SHA; exit 0; else echo TAG_ALREADY_EXISTS_DIFFERENT_SHA >&2; exit 42; fi; fi`,
    `local_target=$(git -C ${quote(worktree)} rev-list -n 1 ${quote(tagRef)} 2>/dev/null || true)`,
    `if [ -n "$local_target" ]; then if [ "$local_target" != ${quote(sha)} ]; then echo LOCAL_TAG_SHA_MISMATCH >&2; exit 42; fi; git -C ${quote(worktree)} push origin ${quote(tagRef)}; exit $?; fi`,
    `git -C ${quote(worktree)} tag -a ${quote(tag)} ${quote(sha)} -m ${quote(`Release ${tag}`)}`,
    `git -C ${quote(worktree)} push origin ${quote(tagRef)}`
  ].join('; ');
}
