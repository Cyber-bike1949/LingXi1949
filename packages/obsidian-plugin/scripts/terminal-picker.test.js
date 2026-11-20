import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temporary = await mkdtemp(path.join(tmpdir(), 'terminal-picker-test-'));
after(() => rm(temporary, { recursive: true, force: true }));
class TestView {
  constructor(binding, remote) {
    this.terminal = { getAiCliFileBinding: () => binding, getTitle: () => 'Example', remote };
  }
  getTerminalInstance() { return this.terminal; }
}
globalThis.PickerTestView = TestView;
await build({
  entryPoints: ['src/ui/terminal/terminalPickerMenu.ts'],
  outfile: path.join(temporary, 'picker.mjs'), bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'stubs', setup(builder) {
    builder.onResolve({ filter: /^(obsidian|\.\/terminalView|\.\.\/\.\.\/i18n)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: args.path === 'obsidian' ? 'export class Menu {} export class Notice {}'
        : args.path === './terminalView' ? 'export const TERMINAL_VIEW_TYPE = "terminal"; export const TerminalView = globalThis.PickerTestView;'
        : 'export function t(key) { return key; }', loader: 'js',
    }));
  } }],
});
const { listConnectedTerminals } = await import(pathToFileURL(path.join(temporary, 'picker.mjs')).href);
delete globalThis.PickerTestView;
for (const [binding, remote, expected] of [
  [{ deviceId: 'controlled' }, 'controller', 'controlled'],
  [{ deviceId: 'controlled' }, null, 'controlled'],
  [null, 'controller', 'controller'],
]) {
  test(`picker targets ${expected} from ${remote} with binding ${!!binding}`, () => {
    const leaf = { view: new TestView(binding, remote) };
    const plugin = {
      getDeviceConnectionManager: () => ({ isConnected: id => id === expected }),
      getRemoteNodeId: terminal => terminal.remote,
      getPairedDeviceStore: () => new Map(),
    };
    const terminals = listConnectedTerminals({ workspace: { getLeavesOfType: () => [leaf] } }, plugin);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].nodeId, expected);
  });
}
