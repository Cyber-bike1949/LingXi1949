/**
 * Vault <-> filesystem copy bridge for the directory tree panel (candidate
 * doc §4.1 points 4/6, §6.4).
 *
 * Two directions, deliberately asymmetric (candidate doc §6.4):
 *  - vault -> fs (drop onto a tree node): same-name conflicts overwrite,
 *    same as the existing vault -> terminal-cwd drop. The target is a
 *    working directory, not the vault.
 *  - fs -> vault ("copy to vault" on a tree node, see the panel's context
 *    menu): same-name conflicts follow the `overwriteOnDuplicateFilename`
 *    setting (requirement 2 of the v1.8 iteration doc) - overwrite in
 *    place by default, or fall back to `resolveUniqueVaultPath`'s "(2)"
 *    suffix when the user turns that off.
 *
 * Kept apart from the panel UI so the walking/copying logic isn't tangled
 * up with DOM/drag event handling. Not unit tested directly (needs a real
 * `App`/`Vault`, same as `vaultLinkSource.ts`); `resolveUniqueVaultPath`,
 * the one pure decision made here, has its own tests.
 */

import type { App, TFile, TFolder } from 'obsidian';
import { TFile as TFileClass, TFolder as TFolderClass } from 'obsidian';

import { checkRelativePath, normalizeVaultPath } from '../remote/pathSafety.ts';
import { checkQuotas, type CollectedFile } from '../remote/noteCollector.ts';
import { collectRecursive, type SkippedNote } from '../remote/noteCollectorRecursive.ts';
import { createVaultLinkSource, createVaultLinkSourceForPath, readVaultFile } from '../remote/vaultLinkSource.ts';
import type { PulledFile } from '../remote/transferStreamPuller.ts';
import type { DirectoryEntry } from '../remote/terminalStreamFrame.ts';
import type { DeviceConnectionManager } from '../remote/deviceConnections.ts';
import { resolveUniqueVaultPath } from './directoryTreeVaultNaming.ts';
import { debugLog } from '../../utils/logger.ts';

/** Called after each file lands, with the running count so far - lets a caller drive a progress notice. */
export type CopyProgressCallback = (filesDone: number) => void;

/**
 * Custom drag MIME for a directory-tree row (candidate doc "目录树与双向文件
 * 传输" §4.1 point 5's replacement for a real OS-level drag - see
 * `directoryTreePanel.ts`'s doc comment). Distinct from anything Obsidian or
 * the OS itself would ever produce, so a global drop listener (registered
 * once, plugin-wide, in `main.ts`) can tell "this drag came from our own
 * tree" apart from Obsidian's internal note-move drags and real OS file
 * drops, and ignore everything else untouched.
 */
export const DIRECTORY_TREE_DRAG_MIME = 'application/x-termy-directory-tree-entry';

export interface DirectoryTreeDragPayload {
  path: string;
  isDirectory: boolean;
  baseName: string;
  /** The device the entry lives on, or `null` for the local filesystem. */
  nodeId: string | null;
}

interface MinimalFsPromises {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  readFile(path: string): Promise<Buffer>;
}

export interface FsAccess {
  promises: MinimalFsPromises;
  join(...segments: string[]): string;
}

export interface CopyResult {
  fileCount: number;
  /** D-01-5: entries skipped because `checkRelativePath` rejected the resulting vault path, not silently dropped. */
  skippedCount?: number;
}

/**
 * Ensures `vaultPath` exists as a folder, creating it if needed (D-01-3).
 * A folder that already exists there is left alone - D-01-6: a directory
 * name collision is a merge, never an overwrite. Callers are expected to
 * walk from shallow to deep (`sortDirectoriesByDepth`) so a parent is
 * always created before any child that depends on it existing.
 */
async function ensureVaultFolder(app: App, vaultPath: string): Promise<void> {
  if (vaultPath === '') return; // the vault root always exists
  const existing = app.vault.getAbstractFileByPath(vaultPath);
  if (existing instanceof TFolderClass) return;
  if (existing instanceof TFileClass) {
    // A file already occupies this path - nothing sane to do but skip the
    // folder creation; whatever needed to land inside it will itself be
    // rejected as invalid by the caller's own checkRelativePath check.
    return;
  }
  await app.vault.createFolder(vaultPath);
}

/** Shallow-to-deep by path segment count, so a parent folder is always created before its children (D-01-3). */
function sortDirectoriesByDepth(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.split('/').length - b.split('/').length);
}

/**
 * Copies a single vault file or an entire vault folder (recursively) into
 * `targetDir` on the local filesystem. Mirrors the folder's own name and
 * structure under `targetDir`, matching how the existing note-transfer
 * flow preserves vault-relative structure on the receiving end.
 */
export async function copyVaultEntryToDirectory(
  app: App,
  entry: TFile | TFolder,
  targetDir: string,
  fsAccess: FsAccess,
  onProgress?: CopyProgressCallback,
): Promise<CopyResult> {
  await fsAccess.promises.mkdir(targetDir, { recursive: true });

  if (entry instanceof TFileClass) {
    const bytes = await readVaultFileBytes(app, entry);
    await fsAccess.promises.writeFile(fsAccess.join(targetDir, entry.name), bytes);
    onProgress?.(1);
    return { fileCount: 1 };
  }

  let fileCount = 0;
  const walk = async (folder: TFolder, destDir: string): Promise<void> => {
    await fsAccess.promises.mkdir(destDir, { recursive: true });
    for (const child of folder.children) {
      if (child instanceof TFolderClass) {
        await walk(child, fsAccess.join(destDir, child.name));
      } else if (child instanceof TFileClass) {
        const bytes = await readVaultFileBytes(app, child);
        await fsAccess.promises.writeFile(fsAccess.join(destDir, child.name), bytes);
        fileCount += 1;
        onProgress?.(fileCount);
      }
    }
  };
  await walk(entry, fsAccess.join(targetDir, entry.name));
  return { fileCount };
}

async function readVaultFileBytes(app: App, file: TFile): Promise<Uint8Array> {
  const buffer = await app.vault.readBinary(file);
  return new Uint8Array(buffer);
}

export interface CopyNoteWithLinksResult extends CopyResult {
  /** Linked notes that could not be collected, same shape `sendNoteRecursively` surfaces. */
  skippedNotes: SkippedNote[];
}

/**
 * Copies a Markdown note and every note/attachment it links to, recursively,
 * onto the local filesystem under `targetDir` - the vault -> fs counterpart
 * to `sendNoteRecursively.ts` (which does the same walk for a remote-device
 * send). Each file lands at its own vault-relative path under `targetDir`,
 * which keeps the note's linked structure exactly as it was in the vault
 * without having to guess which folder the drag "really" meant as its root.
 */
export async function copyVaultNoteWithLinksToDirectory(
  app: App,
  file: TFile,
  targetDir: string,
  fsAccess: FsAccess,
  onProgress?: CopyProgressCallback,
): Promise<CopyNoteWithLinksResult> {
  const collected = collectRecursive(createVaultLinkSource(app, file), (path) =>
    createVaultLinkSourceForPath(app, path)
  );
  if (!collected.ok) throw new Error(collected.error ?? `Unable to collect links for "${file.path}"`);

  const quota = checkQuotas(collected.files);
  if (!quota.ok) throw new Error(quota.error ?? 'Transfer quota exceeded');

  let fileCount = 0;
  for (const collectedFile of collected.files) {
    const segments = collectedFile.relativePath.split('/');
    const destDir = fsAccess.join(targetDir, ...segments.slice(0, -1));
    await fsAccess.promises.mkdir(destDir, { recursive: true });
    const bytes = await readVaultFile(app, collectedFile.relativePath);
    await fsAccess.promises.writeFile(fsAccess.join(destDir, segments[segments.length - 1]), bytes);
    fileCount += 1;
    onProgress?.(fileCount);
  }

  return { fileCount: collected.files.length, skippedNotes: collected.skippedNotes };
}

/**
 * Copies a filesystem file or directory (recursively) into the vault under
 * `targetVaultFolder`. Every path is checked with `checkRelativePath`
 * before writing (candidate doc §6.5: the tree itself isn't sandboxed to a
 * root, so the one thing worth re-validating on the way *into* the vault is
 * that the resulting vault path is well-formed) and de-conflicted per
 * `overwriteOnDuplicate` (requirement 2: default overwrite, or the
 * pre-existing `resolveUniqueVaultPath` "(2)" suffix behavior when off).
 */
export async function copyFsEntryToVault(
  app: App,
  absolutePath: string,
  isDirectory: boolean,
  targetVaultFolder: string,
  fsAccess: FsAccess,
  baseName: string,
  overwriteOnDuplicate: boolean,
  onProgress?: CopyProgressCallback,
): Promise<CopyResult> {
  if (!isDirectory) {
    const desired = normalizeVaultPath(joinVaultPath(targetVaultFolder, baseName));
    const check = checkRelativePath(desired);
    if (!check.ok) throw new Error(`Cannot copy to "${desired}": not a valid vault path`);
    const bytes = await fsAccess.promises.readFile(absolutePath);
    await writeVaultBinaryResolvingConflict(app, desired, bytes, overwriteOnDuplicate);
    onProgress?.(1);
    return { fileCount: 1 };
  }

  let fileCount = 0;
  let skippedCount = 0;
  // D-01-3/D-01-1: every directory visited is created up front, whether or
  // not it turns out to hold any files - an empty subdirectory must still
  // be reflected in the vault, not just directories that happen to contain
  // a file that gets written anyway.
  const walk = async (srcDir: string, destVaultDir: string): Promise<void> => {
    const check = checkRelativePath(destVaultDir);
    if (!check.ok) {
      skippedCount += 1;
      return; // skip individually-invalid directories rather than abort the whole copy
    }
    await ensureVaultFolder(app, destVaultDir);

    const entries = await fsAccess.promises.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = fsAccess.join(srcDir, entry.name);
      const destPath = normalizeVaultPath(joinVaultPath(destVaultDir, entry.name));
      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
        continue;
      }
      const fileCheck = checkRelativePath(destPath);
      if (!fileCheck.ok) {
        skippedCount += 1; // skip individually-invalid entries rather than abort the whole copy
        continue;
      }
      const bytes = await fsAccess.promises.readFile(srcPath);
      await writeVaultBinaryResolvingConflict(app, destPath, bytes, overwriteOnDuplicate);
      fileCount += 1;
      onProgress?.(fileCount);
    }
  };
  await walk(absolutePath, joinVaultPath(targetVaultFolder, baseName));
  return { fileCount, skippedCount };
}

/**
 * Writes the files a `TransferStreamPuller` pulled from a remote device
 * into the vault under `targetVaultFolder` (candidate doc phase 2B: the
 * remote counterpart to `copyFsEntryToVault`'s local-fs walk). Each
 * `relativePath` already includes the pulled root's own name where
 * relevant (a single file is just its basename; a pulled directory's
 * entries are prefixed with that directory's name, mirroring how
 * `copyFsEntryToVault` roots its local walk at `targetVaultFolder/baseName`)
 * , so no separate `baseName` join is needed here.
 */
export async function writePulledFilesToVault(
  app: App,
  files: PulledFile[],
  directories: DirectoryEntry[],
  targetVaultFolder: string,
  overwriteOnDuplicate: boolean,
  onProgress?: CopyProgressCallback,
): Promise<CopyResult> {
  let skippedCount = 0;
  // D-01-3/D-01-1: every directory the agent reported - including one with
  // no files under it - is created before any file is written, shallow to
  // deep so a parent always exists before its children.
  for (const relativePath of sortDirectoriesByDepth(directories.map((d) => d.relativePath))) {
    const desired = normalizeVaultPath(joinVaultPath(targetVaultFolder, relativePath));
    const check = checkRelativePath(desired);
    if (!check.ok) {
      skippedCount += 1;
      continue;
    }
    await ensureVaultFolder(app, desired);
  }

  let fileCount = 0;
  for (const file of files) {
    const desired = normalizeVaultPath(joinVaultPath(targetVaultFolder, file.relativePath));
    const check = checkRelativePath(desired);
    if (!check.ok) {
      skippedCount += 1; // skip individually-invalid entries rather than abort the whole copy
      continue;
    }
    await writeVaultBinaryResolvingConflict(app, desired, file.data, overwriteOnDuplicate);
    fileCount += 1;
    onProgress?.(fileCount);
  }
  return { fileCount, skippedCount };
}

/**
 * Writes `bytes` to `desiredPath`, resolving a same-name conflict per the
 * `overwriteOnDuplicateFilename` setting (requirement 2): overwrite the
 * existing file in place via `modifyBinary`, or fall back to
 * `resolveUniqueVaultPath`'s "(2)" suffix when the setting is off (the
 * pre-existing behavior). A logged trace is the only trail an overwrite
 * leaves - no confirmation dialog, per the confirmed requirement.
 */
async function writeVaultBinaryResolvingConflict(
  app: App,
  desiredPath: string,
  bytes: Uint8Array,
  overwriteOnDuplicate: boolean,
): Promise<void> {
  const exists = (vaultPath: string): boolean => app.vault.getAbstractFileByPath(vaultPath) !== null;

  if (overwriteOnDuplicate) {
    const existing = app.vault.getAbstractFileByPath(desiredPath);
    if (existing instanceof TFileClass) {
      debugLog('[directoryTreeDrop] Overwriting existing vault file on duplicate-name drop:', desiredPath);
      await app.vault.modifyBinary(existing, toArrayBuffer(bytes));
      return;
    }
    // A folder already occupies this path - fall through to a free name
    // instead, since a folder can't be overwritten by a file write.
  }

  const finalPath = resolveUniqueVaultPath(desiredPath, exists);
  await app.vault.createBinary(finalPath, toArrayBuffer(bytes));
}

/**
 * D-01-2/Q7: a folder pull that fails with exactly the pre-D-01 "nothing to
 * send" wording is diagnostic of a peer `termesh-agent` built before D-01 -
 * a post-fix agent never produces that error for a *folder* request (an
 * empty folder now succeeds via `directories`; only a missing/unreadable
 * path still fails, with a different message). Thrown instead of a generic
 * `Error` so the UI layer can show an upgrade hint instead of the raw wire
 * error, without the two entry points (picker, explorer-drop) each having
 * to re-derive the same "is this an old agent" judgment.
 */
export class RemoteAgentDirectoryPullUnsupportedError extends Error {
  constructor() {
    super('the connected device\'s agent is too old to support folder transfers');
    this.name = 'RemoteAgentDirectoryPullUnsupportedError';
  }
}

/**
 * Copies one directory-tree entry (local or remote, per `entry.nodeId`)
 * into `targetVaultFolder`. Shared by the panel's right-click "复制到
 * Vault" and by dropping a dragged entry onto a folder in Obsidian's real
 * file explorer, so both entry points behave identically.
 */
export async function copyDirectoryTreeEntryToVault(
  app: App,
  connections: Pick<DeviceConnectionManager, 'createTransferPuller'> | null,
  fsAccess: FsAccess,
  entry: DirectoryTreeDragPayload,
  targetVaultFolder: string,
  overwriteOnDuplicate: boolean,
  onProgress?: CopyProgressCallback,
): Promise<CopyResult> {
  if (entry.nodeId) {
    if (!connections) throw new Error('Remote connection is not available');
    const outcome = await connections.createTransferPuller(entry.nodeId, entry.path).run();
    if (!outcome.success) {
      if (entry.isDirectory && /nothing to send/i.test(outcome.message)) {
        throw new RemoteAgentDirectoryPullUnsupportedError();
      }
      throw new Error(outcome.message || 'Pull failed');
    }
    return writePulledFilesToVault(
      app,
      outcome.files,
      outcome.directories,
      targetVaultFolder,
      overwriteOnDuplicate,
      onProgress,
    );
  }
  return copyFsEntryToVault(
    app,
    entry.path,
    entry.isDirectory,
    targetVaultFolder,
    fsAccess,
    entry.baseName,
    overwriteOnDuplicate,
    onProgress,
  );
}

export interface VaultTransferSource {
  files: CollectedFile[];
  /** D-01-4: every folder under `entry` - including `entry` itself when it is a folder, even an empty one. */
  directories: DirectoryEntry[];
  readFile: (relativePath: string) => Promise<Uint8Array>;
}

/**
 * Walks a vault file or folder into the `{files, directories, readFile}`
 * shape `TransferStreamSender` expects (candidate doc §4.1 point 4, remote
 * drop onto a tree node). A different traversal than `noteCollector.collect()`:
 * that one gathers a root note plus only its *directly linked* attachments;
 * this walks every file under `entry`, matching what `copyVaultEntryToDirectory`
 * already does for the local case - the remote and local send directions
 * should behave identically except for where the bytes end up. `directories`
 * mirrors `agent/src/fs_browse.rs`'s `walk_for_pull`: every folder
 * encountered is recorded, whether or not it turns out to hold a file, so
 * an empty one still lands on the far end (D-01-4).
 */
export function collectVaultEntryForTransfer(entry: TFile | TFolder): VaultTransferSource {
  const filesByPath = new Map<string, TFile>();
  const directories: DirectoryEntry[] = [];

  if (entry instanceof TFileClass) {
    filesByPath.set(entry.name, entry);
  } else {
    directories.push({ relativePath: entry.name });
    const walk = (folder: TFolder, prefix: string): void => {
      for (const child of folder.children) {
        const relativePath = `${prefix}/${child.name}`;
        if (child instanceof TFolderClass) {
          directories.push({ relativePath });
          walk(child, relativePath);
        } else if (child instanceof TFileClass) {
          filesByPath.set(relativePath, child);
        }
      }
    };
    walk(entry, entry.name);
  }

  const files: CollectedFile[] = [];
  let index = 0;
  for (const [relativePath, file] of filesByPath) {
    files.push({ index, relativePath, size: file.stat.size });
    index += 1;
  }

  return {
    files,
    directories,
    readFile: async (relativePath: string): Promise<Uint8Array> => {
      const file = filesByPath.get(relativePath);
      if (!file) throw new Error(`Unknown file in transfer: ${relativePath}`);
      const buffer = await file.vault.readBinary(file);
      return new Uint8Array(buffer);
    },
  };
}

function joinVaultPath(folder: string, name: string): string {
  const trimmed = folder.replace(/\/+$/, '');
  return trimmed.length > 0 ? `${trimmed}/${name}` : name;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
