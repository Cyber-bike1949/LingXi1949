/**
 * v2.0 remote directory-tree data source (candidate doc "目录树与双向文件传输",
 * phase 2A): `DirectoryTreeSource` implemented over `fsList`/`fsListResult`/
 * `fsChanged` frames (`terminalStreamFrame.ts`), riding the same
 * `termy/terminal/1` connection as terminal sessions - see that module's
 * doc comment for why there is no separate ALPN.
 *
 * Built against the same `ByteStream`/`openStream` seam as
 * `TerminalStreamTransport`, for the same reason: the seam is already
 * proven against in-memory streams and real QUIC (`agent/src/serve.rs`'s
 * integration tests), so this can be built and tested now without waiting
 * on the plugin-side connection-management UI to land.
 *
 * `list()` and `watch()` are two separate `DirectoryTreeSource` calls, but
 * the wire protocol combines "list" and "watch that same path" into one
 * stream (list once, then push `fsChanged` until the stream closes).
 * Bridging the two: `list()` opens a stream, reads the one `fsListResult`,
 * and closes it; `watch()` opens its *own* stream (discarding the
 * `fsListResult` it also gets back, since the caller already has a listing
 * from its own `list()` call) and keeps it open until disposed. Two
 * streams per expanded node costs one redundant listing but keeps this
 * source a drop-in for the same interface `LocalDirectoryTreeSource`
 * implements, without reshaping `DirectoryTreePanel` around a combined
 * list+watch call.
 */

import { posix, win32 } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { isWindowsStylePath } from '../terminal/terminalPathUtils.ts';
import type { Disposable } from './transport.ts';
import { toDisposable } from './transport.ts';
import type { ByteStream } from './terminalStreamTransport.ts';
import { encodeTerminalStreamFrame, TerminalStreamFrameDecoder, type FsListPayload, type FsListResultPayload, type TerminalStreamFrame } from './terminalStreamFrame.ts';
import type { DirectoryChangeKind, DirectoryEntry, DirectoryMetadata, DirectorySnapshot, DirectoryTreeSource } from '../terminal/directoryTreeSource.ts';

export class RemoteDirectoryTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteDirectoryTreeError';
  }
}

const KNOWN_CHANGE_KINDS: DirectoryChangeKind[] = ['created', 'deleted', 'renamed', 'unknown'];

function normalizeChangeKind(raw: string): DirectoryChangeKind {
  return (KNOWN_CHANGE_KINDS as string[]).includes(raw) ? (raw as DirectoryChangeKind) : 'unknown';
}

/** Reads frames off `stream` until one pops out of `decoder`, or the stream ends. */
async function readOneFrame(stream: ByteStream, decoder: TerminalStreamFrameDecoder): Promise<TerminalStreamFrame> {
  for (;;) {
    const frame = decoder.nextFrame();
    if (frame) return frame;
    const chunk = await stream.read();
    if (chunk === null) {
      throw new RemoteDirectoryTreeError('PROTOCOL_ERROR: the agent closed the stream before responding');
    }
    decoder.push(chunk);
  }
}

export class RemoteDirectoryTreeSource implements DirectoryTreeSource {
  private readonly openStream: () => Promise<ByteStream>;
  private readonly requestTimeoutMs: number;

  constructor(openStream: () => Promise<ByteStream>, requestTimeoutMs = 10_000) {
    this.openStream = openStream;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('requestTimeoutMs must be positive');
    }
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async list(path: string): Promise<DirectoryEntry[]> {
    const result = await this.requestList({ path });
    return result.entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }));
  }

  async stat(path: string): Promise<DirectoryMetadata> {
    const paths = isWindowsStylePath(path) ? win32 : posix;
    const result = await this.requestList({ path: paths.dirname(path), metadataVersion: 1 });
    if (result.metadataVersion !== 1) {
      throw new RemoteDirectoryTreeError('UNSUPPORTED: directory metadata is unavailable');
    }
    const entry = result.entries.find((item) => item.name === paths.basename(path));
    if (!entry) throw new RemoteDirectoryTreeError('NOT_FOUND: directory entry no longer exists');
    return { modifiedAtMs: entry.modifiedAtMs ?? null };
  }

  async snapshot(path: string): Promise<DirectorySnapshot> {
    const result = await this.requestList({ path, metadataVersion: 1 });
    if (result.metadataVersion !== 1 || !result.epoch || result.snapshotSequence === undefined) {
      throw new RemoteDirectoryTreeError('UNSUPPORTED: directory snapshot barrier is unavailable');
    }
    return { epoch: result.epoch, sequence: result.snapshotSequence };
  }

  private async requestList(payload: FsListPayload): Promise<FsListResultPayload> {
    let expired = false;
    let activeStream: ByteStream | undefined;
    const timeoutError = new RemoteDirectoryTreeError('TIMEOUT: directory request timed out');
    // Transport requests also run without a DOM. Node timers belong to the
    // connection runtime rather than a terminal popout's active window.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });
    const request = async (): Promise<FsListResultPayload> => {
      const stream = await this.openStream();
      if (expired) {
        stream.finishWrite();
        throw timeoutError;
      }
      activeStream = stream;
      await stream.write(encodeTerminalStreamFrame({ kind: 'fsList', payload }));
      if (expired) throw timeoutError;
      const frame = await readOneFrame(stream, new TerminalStreamFrameDecoder());
      if (frame.kind === 'fsListResult') return frame.payload;
      if (frame.kind === 'error') throw new RemoteDirectoryTreeError(frame.payload.message);
      throw new RemoteDirectoryTreeError(`PROTOCOL_ERROR: expected fsListResult, got ${frame.kind}`);
    };
    try {
      return await Promise.race([request(), timeout]);
    } finally {
      clearTimeout(timer);
      // Half-close only this directory stream, including timeout/error paths.
      activeStream?.finishWrite();
    }
  }

  watch(path: string, onChange: (kind: DirectoryChangeKind) => void): Disposable {
    let disposed = false;
    let activeStream: ByteStream | null = null;

    void (async () => {
      const stream = await this.openStream();
      if (disposed) {
        stream.finishWrite();
        return;
      }
      activeStream = stream;

      await stream.write(encodeTerminalStreamFrame({ kind: 'fsList', payload: { path } }));
      const decoder = new TerminalStreamFrameDecoder();
      for (;;) {
        let frame = decoder.nextFrame();
        while (frame) {
          // Checked on every frame, not just before each `stream.read()`:
          // dispose() only half-closes the client's write side, it cannot
          // stop bytes already in flight from the agent, so this is what
          // actually stops delivering `onChange` promptly after disposal.
          if (disposed) return;
          if (frame.kind === 'fsChanged') {
            onChange(normalizeChangeKind(frame.payload.kind));
          }
          // The initial fsListResult (the caller already has its own
          // listing from `list()`) and anything else are ignored rather
          // than treated as protocol errors - tolerate a peer quirk rather
          // than killing an otherwise-healthy watch over it.
          frame = decoder.nextFrame();
        }
        if (disposed) return;
        const chunk = await stream.read();
        if (chunk === null) return;
        decoder.push(chunk);
      }
    })().catch(() => {
      // The directory may have disappeared, or the stream failed outright;
      // either way this just stops delivering updates, the same posture
      // `LocalDirectoryTreeSource.watch` takes on an unreadable path.
    });

    return toDisposable(() => {
      disposed = true;
      activeStream?.finishWrite();
    });
  }
}
