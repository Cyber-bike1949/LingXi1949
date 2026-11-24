import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const manual = new URL('./manual.mjs', import.meta.url).href;
const sdk = new URL('../remote-sdk/dist/index.mjs', import.meta.url).href;

test('shell preserves startup output and cleans up on SIGTERM before and after opening', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { shell } from ${JSON.stringify(manual)};
    import { encodeTerminalStreamFrame } from ${JSON.stringify(sdk)};

    const stdin = process.stdin;
    Object.defineProperty(stdin, 'isTTY', { value: true });
    const rawModes = [];
    stdin.setRawMode = mode => rawModes.push(mode);
    const binding = { deviceId: 'fixture', workDir: '/tmp', shell: '/bin/sh' };
    const signalListeners = process.listenerCount('SIGTERM');
    const pending = Promise.withResolvers();
    const opening = shell({ binding, adapter: {
      connected: true,
      connection: { openBi: () => pending.promise },
      close: () => pending.reject(new Error('transport closed')),
    } });
    process.emit('SIGTERM');
    await opening;
    assert.deepEqual(rawModes, []);
    assert.equal(process.listenerCount('SIGTERM'), signalListeners);

    let closedStreams = 0;
    const frames = [];
    const input = Buffer.concat([
      encodeTerminalStreamFrame({ kind: 'opened', payload: { sessionId: 'fixture', shell: '/bin/sh' } }),
      encodeTerminalStreamFrame({ kind: 'data', payload: Buffer.from('STARTUP_OUTPUT') }),
    ]);
    let hasRead = false;
    const stream = {
      send: { async writeAll(frame) { frames.push(frame); }, async finish() { closedStreams++; } },
      recv: { async read() {
        if (hasRead) return new Promise(() => {});
        hasRead = true;
        return input;
      } },
    };
    const interactive = shell({ binding, adapter: {
      connected: true,
      connection: { async openBi() { return stream; } },
    } });
    await new Promise(resolve => setImmediate(resolve));
    process.emit('SIGTERM');
    await interactive;
    assert.deepEqual(rawModes, [true, false]);
    assert.equal(frames.length, 2);
    assert.equal(closedStreams, 1);
    assert.equal(process.listenerCount('SIGTERM'), signalListeners);
  `], { encoding: 'utf8', timeout: 5000 });
  assert.match(output, /STARTUP_OUTPUT/);
});
