import { powershellCommand, powershellLiteral } from './shell.mjs';

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function worktreeCommand({ baseSha, branch, worktree, repositoryRoot, shellKind = 'posix' }) {
  if (shellKind === 'cmd') {
    const repository = repositoryRoot ? ` -C ${powershellLiteral(repositoryRoot)}` : '';
    const steps = [
      `$baseCommitExists = $false; & git${repository} cat-file -e ${powershellLiteral(`${baseSha}^{commit}`)} 2>$null; if ($LASTEXITCODE -eq 0) { $baseCommitExists = $true }; if (-not $baseCommitExists) { $fetchSucceeded = $false; for ($attempt = 1; $attempt -le 3; $attempt++) { & git -c http.version=HTTP/1.1 -c http.proxy=${repository} fetch origin; if ($LASTEXITCODE -eq 0) { $fetchSucceeded = $true; break }; if ($attempt -lt 3) { Start-Sleep -Seconds 2 } }; if (-not $fetchSucceeded) { exit $LASTEXITCODE } }`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `& git${repository} worktree add --detach ${powershellLiteral(worktree)} ${powershellLiteral(baseSha)}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    ];
    if (branch) steps.push(`& git -C ${powershellLiteral(worktree)} switch -c ${powershellLiteral(branch)}`, 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    steps.push('exit 0');
    return powershellCommand(steps.join('; '));
  }
  const repository = repositoryRoot ? ` -C ${quote(repositoryRoot)}` : '';
  const add = `git${repository} fetch origin && git${repository} worktree add --detach ${quote(worktree)} ${quote(baseSha)}`;
  return branch ? `${add} && git -C ${quote(worktree)} switch -c ${quote(branch)}` : add;
}

export function qualityCommand({ worktree, commands, shellKind = 'posix' }) {
  if (shellKind === 'cmd') {
    const encodedCommands = Buffer.from(JSON.stringify(commands), 'utf8').toString('base64');
    return powershellCommand(`Set-Location -LiteralPath ${powershellLiteral(worktree)}; $commands = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommands}')) | ConvertFrom-Json; foreach ($command in $commands) { & cmd.exe /D /S /C $command; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }; exit 0`);
  }
  return `set -e; cd ${quote(worktree)}; ${commands.join(' && ')}`;
}
