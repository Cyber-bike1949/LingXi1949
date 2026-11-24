import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');

export class ApprovedDocumentStore {
  constructor(databasePath) {
    this.directory = databasePath === ':memory:'
      ? null
      : join(dirname(resolve(databasePath)), `${basename(databasePath)}.documents`);
    this.memory = this.directory ? null : new Map();
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('APPROVED_DOCUMENT_DIRECTORY_UNSAFE');
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
  }

  key(taskId, kind) {
    if (!['requirement', 'test-cases'].includes(kind)) throw new Error('APPROVED_DOCUMENT_KIND_INVALID');
    return `${digest(taskId)}.${kind}.md`;
  }

  write(taskId, kind, content, expectedHash, allowExisting = false) {
    if (typeof content !== 'string') throw new Error('APPROVED_DOCUMENT_CONTENT_INVALID');
    if (expectedHash && digest(content) !== expectedHash) throw new Error('APPROVED_DOCUMENT_HASH_MISMATCH');
    const key = this.key(taskId, kind);
    if (this.memory) {
      if (this.memory.has(key)) {
        if (allowExisting && this.memory.get(key) === content) return key;
        throw new Error('APPROVED_DOCUMENT_ALREADY_EXISTS');
      }
      this.memory.set(key, content);
      return key;
    }
    const target = join(this.directory, key);
    if (existsSync(target)) {
      if (allowExisting && readFileSync(target, 'utf8') === content) return key;
      throw new Error('APPROVED_DOCUMENT_ALREADY_EXISTS');
    }
    const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(temporary, 0o600);
      linkSync(temporary, target);
      unlinkSync(temporary);
      return key;
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  writePair(taskId, requirementContent, testCaseContent, requirementHash, testCaseHash, allowExisting = false) {
    const keys = [];
    if (requirementContent !== null && requirementContent !== undefined) keys.push(this.write(taskId, 'requirement', requirementContent, requirementHash, allowExisting));
    if (testCaseContent !== null && testCaseContent !== undefined) keys.push(this.write(taskId, 'test-cases', testCaseContent, testCaseHash, allowExisting));
    return keys;
  }

  read(taskId, kind, expectedHash) {
    const key = this.key(taskId, kind);
    let content;
    try {
      if (this.memory) {
        content = this.memory.get(key);
        if (content === undefined) throw new Error('APPROVED_DOCUMENT_CONTENT_MISSING');
      } else {
        const path = join(this.directory, key);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('APPROVED_DOCUMENT_FILE_UNSAFE');
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('APPROVED_DOCUMENT_PERMISSIONS_UNSAFE');
        content = readFileSync(path, 'utf8');
      }
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('APPROVED_DOCUMENT_CONTENT_MISSING');
      throw error;
    }
    if (expectedHash && digest(content) !== expectedHash) throw new Error('APPROVED_DOCUMENT_HASH_MISMATCH');
    return content;
  }

  remove(taskId, kind) {
    const key = this.key(taskId, kind);
    if (this.memory) { this.memory.delete(key); return; }
    try { unlinkSync(join(this.directory, key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
