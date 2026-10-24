import { randomUUID } from 'node:crypto';
import { encodeTerminalStreamFrame, TerminalStreamFrameDecoder } from '../../src/services/remote/terminalStreamFrame.ts';
export { PairedDeviceStore } from '../../src/services/remote/pairedDeviceStore.ts';
export { pairDevice } from '../../src/services/remote/devicePairing.ts';
export { normalizeControllerIdentitySeed } from '../../src/services/remote/controllerIdentity.ts';

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
