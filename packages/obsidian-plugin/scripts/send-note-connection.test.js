import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(tmpdir(), 'send-note-test-'));
after(() => rm(temporary, { recursive: true, force: true }));
await build({
  entryPoints: ['src/services/remote/sendNoteRecursively.ts'],
  outfile: path.join(temporary, 'send.mjs'), bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'vault-stub', setup(builder) {
    builder.onResolve({ filter: /vaultLinkSource\.ts$/ }, () => ({ path: 'vault', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
      export const createVaultLinkSource = (_app, file) => ({
        rootNotePath: file.path, sizeOf: () => 4,
        links: () => file.path === 'notes/example.md' ? [{raw:'linked',resolved:'notes/linked.md'}] : [],
      });
      export const createVaultLinkSourceForPath = (app, path) => createVaultLinkSource(app, {path});
      export const createVaultBacklinkSource = () => () => [];
      export const readVaultFile = async () => new Uint8Array([110,111,116,101]);
    ` }));
  } }],
});
const { sendNoteRecursively } = await import(pathToFileURL(path.join(temporary, 'send.mjs')).href);

function setup(connect) {
  const sends = [];
  return { sends, connections: {
    connect,
    createTransferSender(nodeId, _id, files, _read, session, target) {
      sends.push({ nodeId, files, session, target });
      return { async run() { return { success: true }; } };
    },
  } };
}
const options = { includeBacklinks: false, sessionTicket: 'session-ticket' };
const send = (connections, extra = {}) => sendNoteRecursively({}, {path:'notes/example.md'}, 'controlled', connections, 'D:\\example', {...options, ...extra});

test('note and linked notes wait for the bound target connection before sending', async () => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const { connections, sends } = setup(async (...args) => { calls.push(args); await ready; });
  const result = send(connections);
  assert.deepEqual(calls, [['controlled', 'session-ticket']]);
  assert.equal(sends.length, 0);
  finish();
  assert.equal((await result).success, true);
  assert.equal(sends[0].nodeId, 'controlled');
  assert.equal(sends[0].target, 'D:\\example');
  assert.deepEqual(sends[0].files.map(file => file.relativePath), ['notes/example.md', 'notes/linked.md']);
});

test('connection errors stop the transfer and retain their actual reason', async () => {
  const { connections, sends } = setup(async () => { throw new Error('TICKET_ID_MISMATCH'); });
  await assert.rejects(send(connections), /TICKET_ID_MISMATCH/);
  assert.equal(sends.length, 0);
});

test('declining transfer confirmation does not connect or transfer', async () => {
  const { connections, sends } = setup(async () => { assert.fail('must not connect'); });
  const result = await send(connections, {confirmBeforeSend: async () => false});
  assert.equal(result.cancelled, true);
  assert.equal(sends.length, 0);
});

test('paired terminals without a session ticket use the stored connection details', async () => {
  const calls = [];
  const { connections } = setup(async (...args) => { calls.push(args); });
  assert.equal((await send(connections, {sessionTicket: undefined})).success, true);
  assert.deepEqual(calls, [['controlled', undefined]]);
});
