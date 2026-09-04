/**
 * v2.0 reverse transfer receiver (candidate doc phase 2B: copying a
 * directory-tree entry into the vault), driving the
 * `transferPullRequest`/`transferPullManifest`/`transferChunk`/
 * `transferFileEnd`/`transferResult` frames (`terminalStreamFrame.ts`) over
 * the same `ByteStream`/`openStream` seam `TransferStreamSender` uses -
 * this is that sender's mirror image: here the *agent* is the one reading
 * files and paced by credit, and this class is the one granting it.
 *
 * Whole files are buffered in memory before being handed back (capped by
 * the agent's own `MAX_FILE_BYTES`/`MAX_TRANSFER_BYTES`, doc §8.4), the
 * same posture `TransferStreamSender.readFile` already takes on the way
 * out - nothing here streams straight to disk, since the caller's target
 * is `Vault.createBinary`, which needs the whole buffer anyway.
 */

import {
  encodeTerminalStreamFrame,
  TerminalStreamFrameDecoder,
  type DirectoryEntry,
  type TerminalStreamFrame,
} from './terminalStreamFrame.ts';
import type { ByteStream } from './terminalStreamTransport.ts';

/** Matches `transfer::CREDIT_STEP` in `agent/src/transfer.rs`. */
const CREDIT_STEP = 1024 * 1024;
const DEFAULT_INITIAL_CREDIT = 4 * 1024 * 1024;

export interface PulledFile {
  relativePath: string;
  data: Uint8Array;
}

export interface TransferPullOutcome {
  success: boolean;
  code: string | null;
  message: string;
  files: PulledFile[];
  /** v1.9 D-01: every directory under the pulled entry - includes the entry itself when it is a directory, even an empty one. */
  directories: DirectoryEntry[];
}

/** `PULL_FAILED: no such file`  -> `PULL_FAILED`. Mirrors `terminalStreamTransport.ts`'s local helper. */
function errorCode(message: string): string {
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message);
  return match ? match[1] : 'PROTOCOL_ERROR';
}

async function readOneFrame(stream: ByteStream, decoder: TerminalStreamFrameDecoder): Promise<TerminalStreamFrame> {
  for (;;) {
    const frame = decoder.nextFrame();
    if (frame) return frame;
    const chunk = await stream.read();
    if (chunk === null) {
      throw new Error('PROTOCOL_ERROR: the agent closed the stream before responding');
    }
    decoder.push(chunk);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class TransferStreamPuller {
  private readonly openStream: () => Promise<ByteStream>;
  private readonly path: string;
  private readonly initialCredit: number;

  constructor(
    openStream: () => Promise<ByteStream>,
    path: string,
    initialCredit: number = DEFAULT_INITIAL_CREDIT,
  ) {
    this.openStream = openStream;
    this.path = path;
    this.initialCredit = initialCredit;
  }

  async run(): Promise<TransferPullOutcome> {
    let stream: ByteStream;
    try {
      stream = await this.openStream();
    } catch (error) {
      return { success: false, code: 'PULL_FAILED', message: describeError(error), files: [], directories: [] };
    }

    try {
      const decoder = new TerminalStreamFrameDecoder();
      await stream.write(
        encodeTerminalStreamFrame({ kind: 'transferPullRequest', payload: { path: this.path } }),
      );

      const first = await readOneFrame(stream, decoder);
      if (first.kind === 'error') {
        return {
          success: false,
          code: errorCode(first.payload.message),
          message: first.payload.message,
          files: [],
          directories: [],
        };
      }
      if (first.kind !== 'transferPullManifest') {
        return {
          success: false,
          code: 'PROTOCOL_ERROR',
          message: `expected transferPullManifest, got ${first.kind}`,
          files: [],
          directories: [],
        };
      }
      const entries = first.payload.entries;
      const directories = first.payload.directories;

      let granted = this.initialCredit;
      let received = 0;
      await stream.write(
        encodeTerminalStreamFrame({ kind: 'transferCredit', payload: { grantedBytes: granted } }),
      );

      const chunksByFile = new Map<number, Uint8Array[]>();
      const files: PulledFile[] = [];

      for (;;) {
        const frame = await readOneFrame(stream, decoder);

        if (frame.kind === 'transferChunk') {
          const { fileIndex, data } = frame.payload;
          const existing = chunksByFile.get(fileIndex);
          if (existing) existing.push(data);
          else chunksByFile.set(fileIndex, [data]);

          received += data.length;
          if (received + CREDIT_STEP >= granted) {
            granted = received + Math.max(CREDIT_STEP, Math.floor(granted / 2));
            await stream.write(
              encodeTerminalStreamFrame({ kind: 'transferCredit', payload: { grantedBytes: granted } }),
            );
          }
          continue;
        }

        if (frame.kind === 'transferFileEnd') {
          const entry = entries[frame.payload.fileIndex];
          if (!entry) {
            return {
              success: false,
              code: 'PROTOCOL_ERROR',
              message: `transferFileEnd for unknown fileIndex ${frame.payload.fileIndex}`,
              files: [],
              directories: [],
            };
          }
          const chunks = chunksByFile.get(frame.payload.fileIndex) ?? [];
          const data = concat(chunks);
          if (data.length !== frame.payload.sentSize) {
            return {
              success: false,
              code: 'PROTOCOL_ERROR',
              message: `${entry.relativePath}: received ${data.length} bytes but sentSize was ${frame.payload.sentSize}`,
              files: [],
              directories: [],
            };
          }
          files.push({ relativePath: entry.relativePath, data });
          chunksByFile.delete(frame.payload.fileIndex);
          continue;
        }

        if (frame.kind === 'transferResult') {
          return {
            ...frame.payload,
            files: frame.payload.success ? files : [],
            directories: frame.payload.success ? directories : [],
          };
        }

        // Anything else (e.g. a stray fs/terminal frame kind on a
        // misbehaving peer) is ignored rather than treated as fatal.
      }
    } catch (error) {
      return { success: false, code: 'PULL_FAILED', message: describeError(error), files: [], directories: [] };
    } finally {
      try {
        stream.finishWrite();
      } catch {
        // The stream is already gone; closing it was the goal anyway.
      }
    }
  }
}
