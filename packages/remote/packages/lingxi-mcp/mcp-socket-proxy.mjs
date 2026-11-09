#!/usr/bin/env node
import { createConnection } from 'node:net';

const index = process.argv.indexOf('--socket');
const socketPath = index >= 0 ? process.argv[index + 1] : undefined;
if (!socketPath) throw new Error('Missing --socket');
const socket = createConnection(socketPath);
socket.on('error', error => { process.stderr.write(`LingXi MCP bridge: ${error.message}\n`); process.exitCode = 1; });
process.stdin.pipe(socket); socket.pipe(process.stdout);
