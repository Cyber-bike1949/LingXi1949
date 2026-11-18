export function powershellCommand(script) {
  const scopedScript = `$env:NO_PROXY = 'github.com'; $env:no_proxy = 'github.com'; $env:GIT_CONFIG_PARAMETERS = "'http.version=HTTP/1.1' 'http.proxy='"; ${script}`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(scopedScript, 'utf16le').toString('base64')}`;
}

export function powershellLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
