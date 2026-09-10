import * as assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteDirectoryTreeError, RemoteDirectoryTreeSource } from './remoteDirectoryTreeSource.ts';
import type { ByteStream } from './terminalStreamTransport.ts';
import { encodeTerminalStreamFrame, TerminalStreamFrameDecoder, type TerminalStreamFrame } from './terminalStreamFrame.ts';

/** Single-consumer async queue backing one direction of a stream pair (mirrors terminalStreamTransport.test.ts). */
class Queue {
  private items: (Uint8Array | null)[] = [];
  private waiter: ((item: Uint8Array | null) => void) | null = null;

  push(item: Uint8Array | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async pop(): Promise<Uint8Array | null> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function streamPair(): [ByteStream, ByteStream] {
  const aToB = new Queue();
  const bToA = new Queue();
  const make = (outgoing: Queue, incoming: Queue): ByteStream => ({
    async write(bytes) {
      outgoing.push(bytes.slice());
    },
    async read() {
      return incoming.pop();
    },
    finishWrite() {
      outgoing.push(null);
    },
  });
  return [make(aToB, bToA), make(bToA, aToB)];
}

/** The agent's end of one fs stream, driven frame-by-frame by each test. */
class FakeAgent {
  private readonly decoder = new TerminalStreamFrameDecoder();
  private readonly stream: ByteStream;

  constructor(stream: ByteStream) {
    this.stream = stream;
  }

  async send(frame: TerminalStreamFrame): Promise<void> {
    await this.stream.write(encodeTerminalStreamFrame(frame));
  }

  async nextFrame(): Promise<TerminalStreamFrame> {
    for (;;) {
      const frame = this.decoder.nextFrame();
      if (frame) return frame;
      const chunk = await this.stream.read();
      assert.ok(chunk !== null, 'the source ended the stream unexpectedly');
      this.decoder.push(chunk);
    }
  }

  /** Resolves once the client half-closes its write side (`finishWrite()`). */
  async waitForClientFinish(): Promise<void> {
    const chunk = await this.stream.read();
    assert.equal(chunk, null, 'expected the client to finish writing');
  }
}

/** Records one `FakeAgent` per stream the source opens, in open order. */
function setup(): { source: RemoteDirectoryTreeSource; agents: FakeAgent[] } {
  const agents: FakeAgent[] = [];
  const openStream = async (): Promise<ByteStream> => {
    const [clientEnd, agentEnd] = streamPair();
    agents.push(new FakeAgent(agentEnd));
    return clientEnd;
  };
  return { source: new RemoteDirectoryTreeSource(openStream), agents };
}

test('list() sends fsList and resolves with the entries from fsListResult', async () => {
  const { source, agents } = setup();
  const listPromise = source.list('/home/user/project');

  const request = await (async () => {
    // agents[0] only exists after openStream() runs, which happens
    // synchronously at the top of list() before the first await settles.
    await Promise.resolve();
    return agents[0].nextFrame();
  })();
  assert.deepEqual(request, { kind: 'fsList', payload: { path: '/home/user/project' } });

  await agents[0].send({
    kind: 'fsListResult',
    payload: {
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'readme.md', isDirectory: false },
      ],
    },
  });

  const entries = await listPromise;
  assert.deepEqual(entries, [
    { name: 'src', isDirectory: true },
    { name: 'readme.md', isDirectory: false },
  ]);

  // list() must not leave the stream open once it has its answer.
  await agents[0].waitForClientFinish();
});

test('list() rejects with the agent-provided message on an error frame', async () => {
  const { source, agents } = setup();
  const listPromise = source.list('/no/such/path');
  await Promise.resolve();
  await agents[0].nextFrame();
  await agents[0].send({ kind: 'error', payload: { message: 'FS_LIST_FAILED: not found' } });

  await assert.rejects(listPromise, (error: unknown) => {
    assert.ok(error instanceof RemoteDirectoryTreeError);
    assert.equal(error.message, 'FS_LIST_FAILED: not found');
    return true;
  });
});

test('watch() delivers fsChanged notifications until disposed', async () => {
  const { source, agents } = setup();
  const changes: string[] = [];
  const disposable = source.watch('/home/user/project', (kind) => changes.push(kind));

  await Promise.resolve();
  await agents[0].nextFrame(); // the fsList handshake
  await agents[0].send({ kind: 'fsListResult', payload: { entries: [] } }); // ignored by watch()
  await agents[0].send({ kind: 'fsChanged', payload: { kind: 'unknown' } });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(changes, ['unknown']);

  disposable.dispose();
  await agents[0].waitForClientFinish();

  await agents[0].send({ kind: 'fsChanged', payload: { kind: 'unknown' } }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(changes, ['unknown'], 'no further changes after dispose');
});

test('an unrecognized change kind normalizes to "unknown"', async () => {
  const { source, agents } = setup();
  const changes: string[] = [];
  source.watch('/home/user/project', (kind) => changes.push(kind));

  await Promise.resolve();
  await agents[0].nextFrame();
  await agents[0].send({ kind: 'fsChanged', payload: { kind: 'something-new' } });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(changes, ['unknown']);
});


for (const [file, parent] of [
  ['/example/notes/demo.txt', '/example/notes'],
  ['C:\\example\\notes\\demo.txt', 'C:\\example\\notes'],
  ['\\\\server\\share\\notes\\demo.txt', '\\\\server\\share\\notes'],
]) {
  test(`stat() queries the target parent using target path semantics: ${file}`, async () => {
    const { source, agents } = setup();
    const pending = source.stat(file);
    await Promise.resolve();
    assert.deepEqual(await agents[0].nextFrame(), {
      kind: 'fsList', payload: { path: parent, metadataVersion: 1 },
    });
    await agents[0].send({ kind: 'fsListResult', payload: {
      metadataVersion: 1, entries: [{ name: 'demo.txt', isDirectory: false, modifiedAtMs: 123456 }],
    } });
    assert.deepEqual(await pending, { modifiedAtMs: 123456 });
    await agents[0].waitForClientFinish();
  });
}

for (const version of [undefined, 2]) {
  test(`stat() reports unsupported metadata version ${version} without inventing a time`, async () => {
    const { source, agents } = setup();
    const pending = source.stat('/example/demo.txt');
    const rejected = assert.rejects(pending, /UNSUPPORTED/);
    await Promise.resolve();
    await agents[0].nextFrame();
    await agents[0].send({ kind: 'fsListResult', payload: {
      ...(version === undefined ? {} : { metadataVersion: version }), entries: [],
    } });
    await rejected;
    await agents[0].waitForClientFinish();
  });
}

test('snapshot() returns the target process commit barrier', async () => {
  const { source, agents } = setup();
  const pending = source.snapshot('/example');
  await Promise.resolve();
  assert.deepEqual(await agents[0].nextFrame(), {
    kind: 'fsList', payload: { path: '/example', metadataVersion: 1 },
  });
  await agents[0].send({ kind: 'fsListResult', payload: {
    metadataVersion: 1, epoch: 'epoch-1', snapshotSequence: 8, entries: [],
  } });
  assert.deepEqual(await pending, { epoch: 'epoch-1', sequence: 8 });
  await agents[0].waitForClientFinish();
});

test('stat() distinguishes unreadable metadata from a missing entry', async () => {
  const { source, agents } = setup();
  const pending = source.stat('/example/demo.txt');
  await Promise.resolve();
  await agents[0].nextFrame();
  await agents[0].send({ kind: 'fsListResult', payload: {
    metadataVersion: 1, entries: [{ name: 'demo.txt', isDirectory: false, modifiedAtMs: null }],
  } });
  assert.deepEqual(await pending, { modifiedAtMs: null });
  const missing = source.stat('/example/demo.txt');
  const rejected = assert.rejects(missing, /NOT_FOUND/);
  await Promise.resolve();
  await agents[1].nextFrame();
  await agents[1].send({ kind: 'fsListResult', payload: { metadataVersion: 1, entries: [] } });
  await rejected;
});

test('a directory timeout closes its stream and a later request can succeed', async () => {
  const [client, peer] = streamPair();
  const agent = new FakeAgent(peer);
  const [nextClient, nextPeer] = streamPair();
  const nextAgent = new FakeAgent(nextPeer);
  const streams = [client, nextClient];
  const source = new RemoteDirectoryTreeSource(async () => streams.shift()!, 100);
  const rejected = assert.rejects(source.stat('/example/demo.txt'), /TIMEOUT/);
  await agent.nextFrame();
  await rejected;
  await agent.waitForClientFinish();
  await agent.send({ kind: 'fsListResult', payload: { metadataVersion: 1, entries: [] } });
  // A separate stream remains usable; timeouts must not poison the connection.
  const pending = source.list('/example');
  await nextAgent.nextFrame();
  await nextAgent.send({ kind: 'fsListResult', payload: { entries: [] } });
  assert.deepEqual(await pending, []);
});

test('a stream that opens after timeout is closed without sending a request', async () => {
  let resolveOpen!: (stream: ByteStream) => void;
  const opened = new Promise<ByteStream>((resolve) => { resolveOpen = resolve; });
  const source = new RemoteDirectoryTreeSource(() => opened, 10);
  await assert.rejects(source.list('/example'), /TIMEOUT/);
  const [client, peer] = streamPair();
  resolveOpen(client);
  assert.equal(await peer.read(), null);
});
