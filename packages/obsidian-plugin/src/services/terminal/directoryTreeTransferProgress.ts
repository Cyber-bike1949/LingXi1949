/**
 * Directory-tree transfer feedback (v1.8 requirement 3): an immediate
 * "transferring" notice the moment a drag/drop starts, a running file
 * count while it works, and a guard against dropping the same source path
 * again while it's still in flight. Without this, a slow network drop
 * looks indistinguishable from a failed one, and the user's natural
 * response - dragging it again - queues up a second, redundant transfer.
 *
 * Deliberately global (module-level `Set`, not per-`TerminalPlugin`
 * instance state) since a duplicate drag of the very same source should be
 * rejected no matter which terminal view or explorer window it lands in.
 */

import { Notice } from 'obsidian';

const inFlightSourceKeys = new Set<string>();

/** `nodeId::path` for a remote entry, `local::path` for a local-fs one - matches how `DirectoryTreeDragPayload` already tells the two apart. */
export function transferSourceKey(nodeId: string | null, path: string): string {
  return `${nodeId ?? 'local'}::${path}`;
}

export function isTransferInFlight(sourceKey: string): boolean {
  return inFlightSourceKeys.has(sourceKey);
}

/**
 * Runs `run` guarded by `sourceKey`, refusing to start a second run for the
 * same key while one is already in flight. Returns `null` (without calling
 * `run`) when a transfer for that key is already active.
 */
export async function withTransferGuard<T>(sourceKey: string, run: () => Promise<T>): Promise<T | null> {
  if (inFlightSourceKeys.has(sourceKey)) return null;
  inFlightSourceKeys.add(sourceKey);
  try {
    return await run();
  } finally {
    inFlightSourceKeys.delete(sourceKey);
  }
}

/**
 * A persistent `Notice` (duration `0`, same idiom `main.ts` already uses
 * for the iroh-runtime download progress) shown for the lifetime of one
 * transfer: created immediately so the user sees "transferring" the instant
 * a drop lands, optionally updated with a running file count, and hidden
 * once the caller shows its own success/failure notice.
 */
export class TransferProgressNotice {
  private readonly notice: Notice;
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
    this.notice = new Notice(label, 0);
  }

  /** Only worth showing once there's more than one file to count - a single-file transfer stays at its initial label. */
  update(filesDone: number): void {
    if (filesDone < 2) return;
    this.notice.setMessage(`${this.label} (${filesDone})`);
  }

  hide(): void {
    this.notice.hide();
  }
}
