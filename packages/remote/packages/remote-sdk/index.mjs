import { randomUUID } from 'node:crypto';
import { encodeTerminalStreamFrame, TerminalStreamFrameDecoder } from '../../../core/src/services/remote/terminalStreamFrame.ts';
export { encodeTerminalStreamFrame, TerminalStreamFrameDecoder };
export { PairedDeviceStore } from '../../../core/src/services/remote/pairedDeviceStore.ts';
export { pairDevice } from '../../../core/src/services/remote/devicePairing.ts';
export { normalizeControllerIdentitySeed } from '../../../core/src/services/remote/controllerIdentity.ts';

// TransportAdapter seam: callers can replace Iroh without changing task storage or MCP.
export class LingxiTransportAdapter {
  constructor(connection, deviceId) {
    if (connection.remoteId().toString() !== deviceId) throw new Error('DEVICE_ID_MISMATCH');
    this.connection = connection;
    this.deviceId = deviceId;
    this.connected = true;
    connection.closed().then(() => { this.connected = false; });
  }

  async bind(workDir, shell) {
    const reply = await this.request({ action: 'bind', workDir, shell, requestId: randomUUID() });
    if (reply.status !== 'SUCCESS') throw new Error(reply.error ?? reply.status);
    const b = reply.binding;
    if (!b || !['sessionId', 'bindingVersion', 'workDir', 'shell'].every(k => typeof b[k] === 'string' && b[k])) {
      throw new Error('INVALID_BINDING');
    }
    return Object.freeze({ ...b, deviceId: this.deviceId, agentFingerprint: this.deviceId });
  }

  async request(request, { signal, onOutput = () => {} } = {}) {
    if (!this.connected) throw new Error('DEVICE_DISCONNECTED');
    if (signal?.aborted) throw new Error('CANCELLED_BEFORE_SEND');
    const message = { ...request, deviceId: this.deviceId };
    let timer;
    let cancel;
    const exchange = async () => {
      const bi = await this.connection.openBi();
      const write = payload => bi.send.writeAll(Array.from(encodeTerminalStreamFrame({ kind: 'task', payload })));
      await write(message);
      cancel = () => { void write({ action: 'command.cancel', requestId: request.requestId }).catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const decoder = new TerminalStreamFrameDecoder();
      while (true) {
        const bytes = await bi.recv.read(65536);
        if (!bytes?.length) throw new Error('CONNECTION_LOST: outcome unknown');
        decoder.push(Uint8Array.from(bytes));
        let frame;
        while ((frame = decoder.nextFrame())) {
          if (frame.kind === 'error') throw new Error(frame.payload.message);
          if (frame.kind !== 'task') throw new Error('UNEXPECTED_FRAME');
          const event = frame.payload;
          if (event.deviceId !== this.deviceId || event.agentFingerprint !== this.deviceId || event.requestId !== request.requestId ||
              (event.sessionId ?? undefined) !== request.sessionId || (event.bindingVersion ?? undefined) !== request.bindingVersion) {
            this.close();
            throw new Error('RESPONSE_IDENTITY_MISMATCH');
          }
          if (event.event === 'output') {
            if (!['stdout', 'stderr'].includes(event.channel) || typeof event.data !== 'string') throw new Error('INVALID_OUTPUT');
            onOutput(event.channel, Buffer.from(event.data, 'base64'));
          } else if (event.event === 'result') {
            if (!['SUCCESS','FAILED','CANCELLED','UNKNOWN','TIMED_OUT','OUTPUT_LIMIT'].includes(event.status)) throw new Error('INVALID_STATUS');
            await bi.send.finish();
            return event;
          } else throw new Error('INVALID_EVENT');
        }
      }
    };
    try {
      return await Promise.race([exchange(), new Promise((_, reject) => {
        timer = setTimeout(() => { this.close(); reject(new Error('TRANSPORT_TIMEOUT: outcome unknown')); }, (request.timeoutMs ?? 120000) + 15000);
      })]);
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  close() {
    this.connected = false;
    this.connection.close(0n, []);
  }
}

// A single authenticated bi-stream owns one interactive PTY.  It deliberately
// has no deviceId argument: the adapter's authenticated connection is the
// immutable target selected before this object is created.
export class RemoteTerminal {
  constructor(adapter, binding) {
    this.adapter = adapter;
    this.binding = Object.freeze({ ...binding });
    this.handlers = new Set();
    this.closeHandlers = new Set();
    this.stream = null;
    this.closed = false;
  }

  async open({ cols = 80, rows = 24 } = {}) {
    if (this.stream || this.closed) throw new Error('TERMINAL_ALREADY_OPEN');
    if (!this.adapter.connected) throw new Error('DEVICE_DISCONNECTED');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('INVALID_TERMINAL_SIZE');
    const bi = await this.adapter.connection.openBi();
    this.stream = bi;
    await bi.send.writeAll(Array.from(encodeTerminalStreamFrame({ kind: 'open', payload: {
      cols, rows, workDir: this.binding.workDir, shell: this.binding.shell,
    } })));
    const decoder = new TerminalStreamFrameDecoder();
    for (;;) {
      const bytes = await bi.recv.read(65536);
      if (!bytes?.length) throw new Error('TERMINAL_OPEN_FAILED: connection closed');
      decoder.push(Uint8Array.from(bytes));
      const frame = decoder.nextFrame();
      if (!frame) continue;
      if (frame.kind === 'error') throw new Error(frame.payload.message);
      if (frame.kind !== 'opened') throw new Error('TERMINAL_OPEN_FAILED: unexpected response');
      void this.pump(decoder);
      return frame.payload;
    }
  }

  onData(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  onClose(handler) { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }
  finish() { for (const handler of this.closeHandlers) handler(); }
  write(data) {
    if (this.closed || !this.stream) throw new Error('TERMINAL_CLOSED');
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    void this.stream.send.writeAll(Array.from(encodeTerminalStreamFrame({ kind: 'data', payload: bytes })));
  }
  resize(cols, rows) {
    if (this.closed || !this.stream) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('INVALID_TERMINAL_SIZE');
    void this.stream.send.writeAll(Array.from(encodeTerminalStreamFrame({ kind: 'resize', payload: { cols, rows } })));
  }
  async close(reason = 'user') {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stream?.send.writeAll(Array.from(encodeTerminalStreamFrame({ kind: 'close', payload: { reason, exitCode: null } })));
      await this.stream?.send.finish();
    } catch { /* The target has already gone away. */ }
    this.finish();
  }
  async pump(decoder) {
    try {
      while (!this.closed) {
        let frame;
        while ((frame = decoder.nextFrame())) {
          if (frame.kind === 'data') for (const handler of this.handlers) handler(Buffer.from(frame.payload));
          if (frame.kind === 'error') throw new Error(frame.payload.message);
          if (frame.kind === 'close') { this.closed = true; this.finish(); return; }
        }
        const bytes = await this.stream.recv.read(65536);
        if (!bytes?.length) { this.closed = true; this.finish(); return; }
        decoder.push(Uint8Array.from(bytes));
      }
    } catch (error) {
      this.closed = true;
      for (const handler of this.handlers) handler(Buffer.from(`\r\n[远程终端已断开：${error.message}]\r\n`));
      this.finish();
    }
  }
}
