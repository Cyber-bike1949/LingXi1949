@echo off
setlocal
set "LINGXI_NODE=%~dp0.runtime\node-v24.22.1-win-x64\node.exe"
if not exist "%LINGXI_NODE%" set "LINGXI_NODE=node"
"%LINGXI_NODE%" "%~dp0packages\lingxi-mcp\cli.mjs" shell %*
set "LINGXI_EXIT=%ERRORLEVEL%"
if not "%LINGXI_EXIT%"=="0" pause
exit /b %LINGXI_EXIT%
