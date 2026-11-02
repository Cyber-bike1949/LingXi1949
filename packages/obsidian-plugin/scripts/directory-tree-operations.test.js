import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(tmpdir(), 'directory-tree-test-'));
after(() => rm(temporary, { recursive: true, force: true }));
await build({
  entryPoints: ['src/ui/terminal/directoryTreePanel.ts'],
  outfile: path.join(temporary, 'panel.mjs'),
  bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'ui-stubs', setup(builder) {
    builder.onResolve({ filter: /^(obsidian|\.\.\/\.\.\/i18n)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: args.path === 'obsidian'
        ? 'export class Menu {} export class Notice {} export class TFile {} export class TFolder {} export function setIcon() {}'
        : 'export function t(key) { return key; }',
      loader: 'js',
    }));
  } }],
});
const { DirectoryTreePanel } = await import(pathToFileURL(path.join(temporary, 'panel.mjs')).href);

for (const status of ['success', 'failed']) {
  test(`move ${status}: reveals only a successful destination using the tree home alias`, async () => {
    const panel = Object.create(DirectoryTreePanel.prototype);
    let focused = false;
    let scrolled = false;
    let refreshed = false;
    const calls = [];
    Object.assign(panel, {
      rootPath: '~', writable: true, operationPending: false,
      pathApi: path.posix, expandedPaths: new Set(),
      source: { async operate(request) {
        calls.push(request);
        if (request.action === 'inspect') return {status:'success', identity:'fixture', mutationVersion:1};
        return {status, newPath:'/home/example/destination/example.txt', mutationVersion:1};
      } },
      treeRootEl: { querySelectorAll() {
        assert.equal(refreshed, true);
        return [{ dataset:{path:'~/destination/example.txt'}, focus() {focused = true;}, scrollIntoView() {scrolled = true;} }];
      } },
      async setRootPath(root, options) {
        assert.equal(root, '~');
        assert.equal(options.keepExpanded, true);
        assert.equal(this.expandedPaths.has('~/destination'), status === 'success');
        await new Promise(resolve => setTimeout(resolve, 5));
        refreshed = true;
      },
    });
    await panel.moveEntry('~/example.txt', '~/destination');
    assert.equal(calls[1].root, '~');
    assert.equal(calls[1].path, 'example.txt');
    assert.equal(calls[1].target, 'destination');
    assert.equal(focused, status === 'success');
    assert.equal(scrolled, status === 'success');
    assert.equal(panel.operationPending, false);
  });
}

test('refresh waits until nested directory rendering finishes', async () => {
  const panel = Object.create(DirectoryTreePanel.prototype);
  let rendered = false;
  Object.assign(panel, {
    destroyed:false, rootGeneration:1,
    source:{async list() {return [{name:'destination', isDirectory:true}];}},
    watchDirectory() {},
    async renderNode() {
      await new Promise(resolve => setTimeout(resolve, 5));
      rendered = true;
    },
  });
  await panel.renderChildrenInto('~', {empty() {}}, 0);
  assert.equal(rendered, true);
});
