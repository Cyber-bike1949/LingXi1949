param([Parameter(ValueFromRemainingArguments=$true)][string[]]$SetupArgs)
# PowerShell 7 can pass its module path to Windows PowerShell 5.1.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$ErrorActionPreference = 'Stop'
$Version = if ($env:LINGXI_REMOTE_VERSION) { $env:LINGXI_REMOTE_VERSION } else { '5.0.3' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid LINGXI_REMOTE_VERSION' }
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64','x86')) { throw 'Only Windows x64 is supported.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'tar.exe is required (included in current Windows versions).' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = if ($env:LINGXI_REMOTE_HOME) { $env:LINGXI_REMOTE_HOME } else { Join-Path $env:LOCALAPPDATA 'LingXiRemote' }
New-Item -ItemType Directory -Force -Path $Base | Out-Null
$Base = (Resolve-Path $Base).Path
$Destination = Join-Path $Base $Version
$LockPath = Join-Path $Base "$Version.lock"
$Lock = $null
$Stage = $null
try {
    $Lock = [IO.File]::Open($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    if (-not (Test-Path $Destination)) {
        $Stage = Join-Path $Base ('.download.' + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $Stage | Out-Null
        $Asset = "lingxi-remote-$Version-win32-x64.tar.gz"
        $Url = "https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-$Version"
        Write-Host "Downloading LingXi Remote $Version..."
        foreach ($File in @($Asset, "$Asset.sha256")) {
            try { Invoke-WebRequest -UseBasicParsing -Uri "$Url/$File" -OutFile (Join-Path $Stage $File) }
            catch { throw "Download failed. Check that remote-$Version is published with ${File}: https://github.com/Cyber-bike1949/LingXi1949/releases. $($_.Exception.Message)" }
        }
        $Checksum = (Get-Content -Raw (Join-Path $Stage "$Asset.sha256")).Trim() -split '\s+'
        if ($Checksum.Count -ne 2 -or $Checksum[0] -notmatch '^[0-9a-fA-F]{64}$' -or $Checksum[1] -ne $Asset) { throw 'Invalid checksum file' }
        if ((Get-FileHash (Join-Path $Stage $Asset) -Algorithm SHA256).Hash -ne $Checksum[0]) { throw 'Package checksum mismatch' }
        $Package = Join-Path $Stage 'package'
        New-Item -ItemType Directory -Path $Package | Out-Null
        & tar.exe -xzf (Join-Path $Stage $Asset) -C $Package
        if ($LASTEXITCODE -ne 0) { throw 'Package extraction failed' }
        foreach ($Required in @('scripts/setup.ps1', 'scripts/setup.mjs', 'bin/lingxi1949.exe')) {
            if (-not (Test-Path (Join-Path $Package $Required) -PathType Leaf)) { throw "Incomplete platform package: $Required" }
        }
        Set-Content -Path (Join-Path $Package '.lingxi-installed') -Value $Checksum[0]
        Move-Item -LiteralPath $Package -Destination $Destination
    } elseif (-not (Test-Path (Join-Path $Destination '.lingxi-installed')) -or -not (Test-Path (Join-Path $Destination 'scripts/setup.ps1')) -or -not (Test-Path (Join-Path $Destination 'scripts/setup.mjs')) -or -not (Test-Path (Join-Path $Destination 'bin/lingxi1949.exe'))) {
        throw "Existing directory is not managed by this installer: $Destination. Choose another LINGXI_REMOTE_HOME."
    }
    # Repair only the published 5.0.0 startup files; preserve identity and configuration.
    if ($Version -eq '5.0.0') {
        $FixUrl = 'https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/packages/remote'
        $Fixes = [ordered]@{
            'package-lock.json' = 'eb6e6d5b4803c063e91d887dbf27859da0e205b94d7e2624fc610a2cad29559a'
            'scripts/setup.ps1' = 'ba7b45dd6e431e3b692853b0c94aa1d3f6c338e32035c82f434563e2f291db0e'
            'control.cmd' = 'f1aaa8c1101b7735f36439b24f0c0259797f16492bac6dd48f1bce19a7ef2171'
            'packages/lingxi-mcp/cli.mjs' = 'e388a20ba975ab81ef8a7d83c42f48c0f652042634e235b3800fd08fd2d0b5a8'
            'packages/lingxi-mcp/strict-ai.mjs' = 'c3658b2d1a0faf1ba9bdf862e1738b9235c690396a964f427ac78a4551822d63'
            'packages/lingxi-mcp/ai-bridge.mjs' = '30a738482add2281aad9c095bdd70b1d26cd5dba9543bf8ba8301e900f8082ec'
            'packages/lingxi-mcp/mcp-socket-proxy.mjs' = 'e8a9f261238f46515ce07efb85dab98df7d2db73e271e4b4634552e09d3d4bd0'
        }
        foreach ($File in $Fixes.Keys) {
            $Target = Join-Path $Destination $File
            if ((Test-Path -LiteralPath $Target) -and (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -eq $Fixes[$File]) { continue }
            if (-not $Stage) {
                $Stage = Join-Path $Base ('.repair.' + [guid]::NewGuid().ToString())
                New-Item -ItemType Directory -Path $Stage | Out-Null
            }
            $Patch = Join-Path $Stage ((Split-Path $File -Leaf) + '.fixed')
            Invoke-WebRequest -UseBasicParsing -Uri "$FixUrl/$File" -OutFile $Patch
            if ((Get-FileHash -LiteralPath $Patch -Algorithm SHA256).Hash -ne $Fixes[$File]) { throw "Repair checksum mismatch: $File" }
            Move-Item -LiteralPath $Patch -Destination $Target -Force
        }
    }
    Write-Host "Installed at: $Destination"
    Write-Host "Manual control: double-click $Destination\control.cmd"
    & (Join-Path $Destination 'scripts/setup.ps1') @SetupArgs
} finally {
    if ($Stage -and (Test-Path $Stage)) { Remove-Item -Recurse -Force $Stage }
    if ($Lock) { $Lock.Dispose(); Remove-Item -LiteralPath $LockPath }
}
