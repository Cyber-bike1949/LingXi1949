@echo off
setlocal
set "LINGXI_NODE=%~dp0.runtime\node-v24.22.1-win-x64\node.exe"
if not exist "%LINGXI_NODE%" set "LINGXI_NODE=node"
if /I "%~1"=="ai" (
  "%LINGXI_NODE%" "%~dp0packages\lingxi-mcp\cli.mjs" %*
) else if /I "%~1"=="codex" (
  "%LINGXI_NODE%" "%~dp0packages\lingxi-mcp\cli.mjs" %*
) else if /I "%~1"=="claude" (
  "%LINGXI_NODE%" "%~dp0packages\lingxi-mcp\cli.mjs" %*
) else (
  "%LINGXI_NODE%" "%~dp0packages\lingxi-mcp\cli.mjs" shell %*
)
set "LINGXI_EXIT=%ERRORLEVEL%"
if not "%LINGXI_EXIT%"=="0" pause
exit /b %LINGXI_EXIT%
