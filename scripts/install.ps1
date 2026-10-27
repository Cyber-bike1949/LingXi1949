# Install release assets without elevation, identity changes, or service activation.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('b', 'c')][string]$Role,
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'LingXi1949-install')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Version = '4.0.0'
if ($env:OS -ne 'Windows_NT' -or [Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'Only Windows x64 has a published Agent. Use install.sh for Linux x64.'
}
$Prefix = [IO.Path]::GetFullPath($Prefix)
if ($Prefix.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Prefix).TrimEnd('\') -or $Prefix.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) {
    throw 'Prefix must be a dedicated installation directory.'
}
$Node = $null
$Npm = $null
if ($Role -eq 'b') {
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    # Avoid embedded quotes: Windows PowerShell 5.1 strips them for native argv.
    & $Node -e 'if (parseInt(process.versions.node) < 24) process.exit(1)'
    if ($LASTEXITCODE -ne 0) { throw 'B requires Node.js 24+ and npm; install Node.js and rerun. Existing Node was not modified.' }
}
$null = Get-Command tar.exe -ErrorAction Stop
foreach ($Directory in @($Prefix, (Join-Path $Prefix 'bin'), (Join-Path $Prefix 'bundles'))) {
    if (Test-Path -LiteralPath $Directory) {
        if (((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $Directory" }
    }
    $null = New-Item -ItemType Directory -Path $Directory -Force
}
$LockPath = Join-Path $Prefix '.install-lock'
$Lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$Stage = Join-Path $Prefix ('bundles\' + $Version + '-' + $Role + '-' + [Guid]::NewGuid().ToString('N'))
$PointerTemp = Join-Path $Prefix ('current-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$Activated = $false
try {
    $null = New-Item -ItemType Directory -Path $Stage
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Base = "https://github.com/Cyber-bike1949/LingXi1949/releases/download/$Version"
    function Get-VerifiedAsset([string]$Name) {
        $Destination = Join-Path $Stage $Name
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$Base/$Name" -OutFile $Destination
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$Base/$Name.sha256" -OutFile "$Destination.sha256"
        $Expected = ((Get-Content -LiteralPath "$Destination.sha256" -Raw).Trim() -split '\s+')[0]
        if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Expected) { throw "Checksum mismatch: $Name" }
    }
    Get-VerifiedAsset 'lingxi1949-win32-x64.exe'
    Move-Item -LiteralPath (Join-Path $Stage 'lingxi1949-win32-x64.exe') -Destination (Join-Path $Stage 'lingxi1949.exe')
    & (Join-Path $Stage 'lingxi1949.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Agent executable check failed' }
    if ($Role -eq 'b') {
        Get-VerifiedAsset "lingxi-mcp-$Version.tar.gz"
        $Mcp = Join-Path $Stage 'mcp'
        $null = New-Item -ItemType Directory -Path $Mcp
        & tar.exe -xzf (Join-Path $Stage "lingxi-mcp-$Version.tar.gz") -C $Mcp
        if ($LASTEXITCODE -ne 0) { throw 'MCP extraction failed' }
        if ((Get-Content -LiteralPath (Join-Path $Mcp 'package.json') -Raw | ConvertFrom-Json).version -ne $Version) { throw 'MCP package version mismatch' }
        Push-Location $Mcp
        try {
            & $Npm install --omit=dev --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'MCP dependency installation failed' }
        } finally { Pop-Location }
        [IO.File]::WriteAllText((Join-Path $Stage 'node-path'), $Node)
        & $Node (Join-Path $Mcp 'packages\lingxi-mcp\cli.mjs') --help --home (Join-Path $Stage 'check-profile')
        if ($LASTEXITCODE -ne 0) { throw 'MCP runtime check failed' }
        Remove-Item -LiteralPath (Join-Path $Stage 'check-profile') -Recurse -Force
    }
    foreach ($Name in @('lingxi1949', 'lingxi-mcp')) {
        $Launcher = Join-Path $Prefix "bin\$Name.ps1"
        if (Test-Path -LiteralPath $Launcher) {
            if (((Get-Item -LiteralPath $Launcher).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Select-String -LiteralPath $Launcher -Pattern '^# LingXi managed launcher v1$' -Quiet)) { throw "Unmanaged launcher exists: $Launcher" }
        }
    }
    $AgentLauncher = @'
# LingXi managed launcher v1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$bundle = [IO.File]::ReadAllText((Join-Path $root 'current.txt')).Trim()
& (Join-Path $bundle 'lingxi1949.exe') @args
exit $LASTEXITCODE
'@
    $McpLauncher = @'
# LingXi managed launcher v1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$bundle = [IO.File]::ReadAllText((Join-Path $root 'current.txt')).Trim()
if (-not (Test-Path -LiteralPath (Join-Path $bundle 'node-path'))) { throw 'MCP not installed; rerun installer with -Role b' }
$nodePath = [IO.File]::ReadAllText((Join-Path $bundle 'node-path')).Trim()
& $nodePath (Join-Path $bundle 'mcp\packages\lingxi-mcp\cli.mjs') @args
exit $LASTEXITCODE
'@
    foreach ($Entry in @(@('lingxi1949', $AgentLauncher), @('lingxi-mcp', $McpLauncher))) {
        $Launcher = Join-Path $Prefix ('bin\' + $Entry[0] + '.ps1')
        if (-not (Test-Path -LiteralPath $Launcher)) { [IO.File]::WriteAllText($Launcher, $Entry[1]) }
    }
    [IO.File]::WriteAllText((Join-Path $Stage 'installed-version'), "$Version $Role")
    [IO.File]::WriteAllText($PointerTemp, $Stage)
    $Pointer = Join-Path $Prefix 'current.txt'
    if (Test-Path -LiteralPath $Pointer) {
        if (((Get-Item -LiteralPath $Pointer).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing reparse point current.txt' }
        [IO.File]::Replace($PointerTemp, $Pointer, $null)
    } else { [IO.File]::Move($PointerTemp, $Pointer) }
    $Activated = $true
    Write-Host "Installed LingXi $Version, role $Role. Identity/configuration unchanged."
    Write-Host "Start Agent: & `"$Prefix\bin\lingxi1949.ps1`" run"
    if ($Role -eq 'b') { Write-Host "MCP help: & `"$Prefix\bin\lingxi-mcp.ps1`" --help" }
    Write-Host 'No service was started. Stop old Agent before starting this one; use the same OS user to retain identity.'
    Write-Host 'Next: https://github.com/Cyber-bike1949/LingXi1949/blob/main/docs/remote-tasks-first-run.zh-CN.md'
} finally {
    if (-not $Activated -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    if (Test-Path -LiteralPath $PointerTemp) { Remove-Item -LiteralPath $PointerTemp -Force }
    $Lock.Dispose()
    # Keep the lock file to avoid a close/delete race between installers.
}
