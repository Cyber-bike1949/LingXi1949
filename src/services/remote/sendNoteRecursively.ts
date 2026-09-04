/**
 * Send orchestration for the v3.1 right-click / note-toolbar entries
 * (`输出文档/v3.1 需求文档采集.md` §2/§3): collect the triggering note plus
 * every note it links to, recursively, then hand the flat file list to the
 * same transfer pipeline `handleRemoteDrop` already uses.
 *
 * A thin Obsidian-facing wrapper around `collectRecursive` — not unit
 * tested directly, same convention as `vaultLinkSource.ts` and
 * `directoryTreeDrop.ts` (needs a real `App`/device connection).
 */

import type { App, TFile } from 'obsidian';

import { checkQuotas, type CollectedFile } from './noteCollector.ts';
import { collectRecursive, type SkippedNote } from './noteCollectorRecursive.ts';
import {
  createVaultBacklinkSource,
  createVaultLinkSource,
  createVaultLinkSourceForPath,
  readVaultFile,
} from './vaultLinkSource.ts';
import type { DeviceConnectionManager } from './deviceConnections.ts';

export interface SendNoteRecursivelyResult {
  success: boolean;
  message?: string;
  /** True when a quota failure is specifically attributable to backlinked notes (R-02-5). */
  quotaExceededByBacklinks?: boolean;
  /** The user declined the R-04-3 confirmation; nothing was sent, no error to show. */
  cancelled?: boolean;
  /** Total files actually sent, for the R-04-2 success notice. */
  fileCount?: number;
  skippedNotes: SkippedNote[];
}

export interface SendNoteRecursivelyOptions {
  /** `sendBacklinkedNotes` setting (R-02-2); false reproduces v1.8 forward-only collection. */
  includeBacklinks: boolean;
  /**
   * R-04-3: called with the fully collected file set before anything is
   * sent. Return false to abort. Omit to always send without asking.
   */
  confirmBeforeSend?: (files: CollectedFile[]) => Promise<boolean>;
}

export async function sendNoteRecursively(
  app: App,
  file: TFile,
  nodeId: string,
  connections: DeviceConnectionManager,
  targetPath: string,
  options: SendNoteRecursivelyOptions,
): Promise<SendNoteRecursivelyResult> {
  const collected = collectRecursive(
    createVaultLinkSource(app, file),
    (path) => createVaultLinkSourceForPath(app, path),
    options.includeBacklinks ? createVaultBacklinkSource(app) : undefined,
  );
  if (!collected.ok) {
    return { success: false, message: collected.error ?? 'Unable to collect note', skippedNotes: [] };
  }

  const quota = checkQuotas(collected.files);
  if (!quota.ok) {
    const quotaExceededByBacklinks = collected.files.some((f) => f.origin === 'backlink');
    return {
      success: false,
      message: quota.error ?? 'Transfer quota exceeded',
      quotaExceededByBacklinks,
      skippedNotes: collected.skippedNotes,
    };
  }

  if (options.confirmBeforeSend) {
    const proceed = await options.confirmBeforeSend(collected.files);
    if (!proceed) {
      return { success: false, cancelled: true, skippedNotes: collected.skippedNotes };
    }
  }

  const outcome = await connections
    .createTransferSender(nodeId, crypto.randomUUID(), collected.files, (path) => readVaultFile(app, path), null, targetPath)
    .run();

  if (!outcome.success) {
    return { success: false, message: outcome.message || 'Transfer failed', skippedNotes: collected.skippedNotes };
  }

  return { success: true, fileCount: collected.files.length, skippedNotes: collected.skippedNotes };
}
