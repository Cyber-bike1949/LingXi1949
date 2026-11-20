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
    directoryLoadTokens: new Map(),
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
    directoryLoadTokens: new Map(),
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

test('transfer refresh preserves expanded directories and modification markers', async () => {
  const panel = Object.create(DirectoryTreePanel.prototype);
  const calls = [];
  Object.assign(panel, {
    directoryLoadTokens: new Map(),
    destroyed: false, rootPath: '/example',
    source: { snapshot() { assert.fail('transfer must not clear modification markers'); } },
    async setRootPath(root, options) { calls.push({ root, options }); },
  });
  await panel.refreshAfterTransfer();
  assert.deepEqual(calls, [{ root: '/example', options: { keepExpanded: true } }]);
  panel.destroyed = true;
  await panel.refreshAfterTransfer();
  assert.equal(calls.length, 1);
});

class TreeElement {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
  }
  createDiv(options) {
    const child = new TreeElement();
    child.options = options;
    this.children.push(child);
    return child;
  }
  createSpan(options) { return this.createDiv(options); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  toggleClass() {}
  removeClass() {}
  empty() { this.children = []; }
}

test('Windows file-row drop and manual refresh render a new Chinese note in the same root', async () => {
  const panel = Object.create(DirectoryTreePanel.prototype);
  const root = 'D:\\example-project';
  const tree = new TreeElement();
  const entries = [{ name: 'README.md', isDirectory: false }];
  let target;
  Object.assign(panel, {
    directoryLoadTokens: new Map(),
    destroyed: false, rootGeneration: 0, rootPath: root,
    pathApi: path.win32, treeRootEl: tree,
    pathInputEl: { setAttribute() {} },
    expandedPaths: new Set(), watches: new Map(),
    source: {
      async list(requested) { assert.equal(requested, root); return entries.slice(); },
      async snapshot(requested) { assert.equal(requested, root); return { epoch: 'example', sequence: 1 }; },
    },
    callbacks: { onDropToPath(_transfer, destination) {
      target = destination;
      entries.push({ name: '示例笔记.md', isDirectory: false });
    } },
    clearMtimeTooltip() {}, watchDirectory() {},
  });
  await panel.setRootPath(root);
  const fileRow = tree.children[0];
  fileRow.listeners.get('drop')({
    dataTransfer: { types: ['text/plain'] }, preventDefault() {}, stopPropagation() {},
  });
  assert.equal(target, root);
  await panel.refreshWithBarrier(root);
  assert.deepEqual(tree.children.map(row => row.dataset.path), [
    'D:\\example-project\\README.md', 'D:\\example-project\\示例笔记.md',
  ]);
  assert.equal(tree.children[1].children[2].options.text, '示例笔记.md');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const staleResult of ['listing', 'error']) {
  test(`late directory ${staleResult} cannot replace a newer listing`, async () => {
    const panel = Object.create(DirectoryTreePanel.prototype);
    const older = deferred();
    const newer = deferred();
    const pending = [older, newer];
    const container = { rows: [], empty() { this.rows = []; }, createDiv(value) { this.rows.push(value.text); } };
    Object.assign(panel, {
    directoryLoadTokens: new Map(),
      destroyed: false, rootGeneration: 1,
      source: { list() { return pending.shift().promise; } },
      watchDirectory() {},
      async renderNode(entry) { container.rows.push(entry.name); },
    });
    const first = panel.renderChildrenInto('D:\\example-project', container, 0);
    const second = panel.renderChildrenInto('D:\\example-project', container, 0);
    newer.resolve([{ name: '示例笔记.md', isDirectory: false }]);
    await second;
    if (staleResult === 'listing') older.resolve([{ name: 'README.md', isDirectory: false }]);
    else older.reject(new Error('stale connection'));
    await first;
    assert.deepEqual(container.rows, ['示例笔记.md']);
  });
}

test('disposed directory watcher cannot start another listing after manual refresh', () => {
  const panel = Object.create(DirectoryTreePanel.prototype);
  let callback;
  let reloads = 0;
  Object.assign(panel, {
    directoryLoadTokens: new Map(),
    destroyed: false, rootGeneration: 1, watches: new Map(),
    source: { watch(_path, listener) { callback = listener; return { dispose() {} }; } },
    renderChildrenInto() { reloads += 1; },
  });
  panel.watchDirectory('D:\\example-project', {}, 0);
  panel.disposeAllWatches();
  callback('created');
  assert.equal(reloads, 0);
});
