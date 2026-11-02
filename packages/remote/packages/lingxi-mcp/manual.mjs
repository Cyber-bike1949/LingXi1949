import { open, stat, link, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const CHUNK = 128 * 1024;
const LIMIT = 64 * 1024 * 1024;
const required = (options, key) => {
  if (!options[key]) throw new Error(`Missing --${key}`);
  return options[key];
};

export async function operation(service, action, fields, signal) {
  const task = await service.run({ action, ...fields, requestId: randomUUID() }, event => {
    (event.channel === 'stderr' ? process.stderr : process.stdout).write(event.text);
  }, signal);
  if (task.status !== 'SUCCESS') {
    const error = new Error(`${task.status}: ${task.result?.error ?? `exit ${task.result?.exitCode ?? 'unknown'}`}`);
    error.status = task.status;
    error.exitCode = task.result?.exitCode;
    throw error;
  }
  return task.result?.result ?? task.result;
}

export async function upload(service, local, path, overwrite = false, signal) {
  const file = await open(local, 'r');
  let uploadId;
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('NOT_A_FILE: directory transfer is not enabled');
    if (before.size > LIMIT) throw new Error('FILE_TOO_LARGE: 64 MiB maximum');
    const started = await operation(service, 'fs.uploadStart', { path, size: before.size, overwrite }, signal);
    uploadId = started.upload;
    let offset = 0;
    while (offset < before.size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, before.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error('SOURCE_CHANGED');
      await operation(service, 'fs.uploadChunk', { path, upload: uploadId, offset, data: buffer.toString('base64') }, signal);
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('SOURCE_CHANGED');
    const result = await operation(service, 'fs.uploadCommit', { path, upload: uploadId, size: before.size, overwrite }, signal);
    uploadId = undefined;
    return result;
  } finally {
    await file.close();
    if (uploadId) await operation(service, 'fs.uploadAbort', { path, upload: uploadId }).catch(error => {
      process.stderr.write(`Upload cleanup incomplete (${uploadId}): ${error.message}\n`);
    });
  }
}

export async function download(service, path, local, overwrite = false, signal) {
  const destination = resolve(local);
  if (!overwrite) {
    try { await stat(destination); throw new Error('DESTINATION_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = await operation(service, 'fs.stat', { path }, signal);
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > LIMIT || typeof info.identity !== 'string') throw new Error('INVALID_FILE_METADATA');
  const temporary = join(dirname(destination), `.lingxi-download-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    let offset = 0;
    do {
      const result = await operation(service, 'fs.readChunk', { path, offset, identity: info.identity }, signal);
      const bytes = Buffer.from(result.data, 'base64');
      if (result.offset !== offset || result.identity !== info.identity || result.size !== info.size ||
          bytes.length > CHUNK || offset + bytes.length > info.size || (!bytes.length && offset < info.size)) throw new Error('INVALID_FILE_CHUNK');
      await file.writeFile(bytes);
      offset += bytes.length;
    } while (offset < info.size);
    await file.sync();
    await file.close();
    if (overwrite) await rename(temporary, destination);
    else { await link(temporary, destination); await unlink(temporary); }
    return { path: destination, bytesWritten: info.size };
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') process.stderr.write(`Cleanup incomplete: ${error.message}\n`); });
  }
}

export async function runManual(service, command, options) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  try {
    if (command === 'exec') {
      const timeoutMs = Number(options.timeout ?? 120000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('INVALID_TIMEOUT');
      return await operation(service, 'command.run', { command: required(options, 'command'), timeoutMs }, abort.signal);
    }
    if (command === 'list') return await operation(service, 'fs.list', { path: options.path ?? '.' }, abort.signal);
    if (command === 'upload') return await upload(service, required(options, 'local'), required(options, 'path'), options.overwrite === 'true', abort.signal);
    if (command === 'download') return await download(service, required(options, 'path'), required(options, 'local'), options.overwrite === 'true', abort.signal);
    throw new Error('UNKNOWN_MANUAL_COMMAND');
  } finally { process.removeListener('SIGINT', stop); }
}

export async function shell(service) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('输入远程命令；/ls [路径] 浏览，/upload 上传，/download 下载，/exit 退出。\n同名默认拒绝覆盖；每条命令独立执行，工作目录固定。\n');
  try {
    while (true) {
      let line;
      try { line = (await reader.question('lingxi> ')).trim(); } catch { break; }
      if (line === '/exit') break;
      if (!line) continue;
      try {
        let command = 'exec'; let options = { command: line };
        if (line === '/ls' || line.startsWith('/ls ')) { command = 'list'; options = { path: line.slice(3).trim() || '.' }; }
        if (line === '/upload' || line === '/download') {
          command = line.slice(1);
          options = { local: await reader.question('本地文件路径: '), path: await reader.question('远程相对文件路径: ') };
          options.overwrite = (await reader.question('允许覆盖已有文件？输入 yes，否则拒绝: ')).trim() === 'yes' ? 'true' : 'false';
        }
        const result = await runManual(service, command, options);
        process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
      } catch (error) { process.stderr.write(`${error.message}\n`); }
    }
  } finally { reader.close(); }
}
