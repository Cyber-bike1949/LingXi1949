param([Parameter(Mandatory=$true)][string]$Obsidian, [Parameter(Mandatory=$true)][string]$Agent, [string]$Plugin='plugin-package', [string]$Output='test-results/obsidian')
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & npm.cmd ci --prefix e2e/obsidian --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Test dependency installation failed' }
  & node e2e/obsidian/run.mjs --obsidian $Obsidian --agent $Agent --plugin $Plugin --output $Output
  if ($LASTEXITCODE -ne 0) { throw "Obsidian UI tests failed. See $Output/report.json" }
} finally { Pop-Location }
