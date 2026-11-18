import test from 'node:test';
import assert from 'node:assert/strict';
import { powershellCommand } from '../src/shell.mjs';

test('scopes the GitHub proxy bypass to a PowerShell command process', () => {
  const command = powershellCommand('Write-Output ready');
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /\$env:NO_PROXY = 'github\.com'/);
  assert.match(script, /\$env:GIT_CONFIG_PARAMETERS = "'http\.version=HTTP\/1\.1' 'http\.proxy='"/);
  assert.match(script, /Write-Output ready/);
});
