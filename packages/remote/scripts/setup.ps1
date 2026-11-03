param([Parameter(ValueFromRemainingArguments=$true)][string[]]$SetupArgs)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Version = 'v24.22.1'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64','x86')) { throw 'Only Windows x64 is supported.' }
$ValidNode = $false
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
  & node -e 'if(parseInt(process.versions.node,10)<24)process.exit(1)'
  $ValidNode = $LASTEXITCODE -eq 0
}
if (-not $ValidNode) {
  $Runtime = Join-Path $Root '.runtime'
  $NodeDir = Join-Path $Runtime "node-$Version-win-x64"
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    $Stage = Join-Path $Runtime ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $Stage | Out-Null
    try {
      $Asset = "node-$Version-win-x64.zip"
      $Base = "https://nodejs.org/dist/$Version"
      Invoke-WebRequest -UseBasicParsing "$Base/$Asset" -OutFile (Join-Path $Stage $Asset)
      Invoke-WebRequest -UseBasicParsing "$Base/SHASUMS256.txt" -OutFile (Join-Path $Stage 'SHASUMS256.txt')
      $Line = Get-Content (Join-Path $Stage 'SHASUMS256.txt') | Where-Object { $_.EndsWith("  $Asset") }
      if (-not $Line -or (Get-FileHash (Join-Path $Stage $Asset) -Algorithm SHA256).Hash.ToLower() -ne $Line.Split(' ')[0]) { throw 'Node checksum mismatch' }
      Expand-Archive (Join-Path $Stage $Asset) -DestinationPath $Runtime
    } finally { Remove-Item -Recurse -Force $Stage }
  }
  $env:PATH = "$NodeDir;$env:PATH"
}
Push-Location $Root
try {
  $DependenciesReady = $false
  try {
    & node -e "require('@number0/iroh')" 2>$null
    $DependenciesReady = $LASTEXITCODE -eq 0
  } catch { $DependenciesReady = $false }
  if (-not $DependenciesReady) {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  }
  & node -e "require('@number0/iroh')"
  if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency is unavailable. Please rerun the online installer.' }
  & node scripts/setup.mjs @SetupArgs
  if ($LASTEXITCODE -ne 0) { throw 'Setup did not complete' }
} finally { Pop-Location }
