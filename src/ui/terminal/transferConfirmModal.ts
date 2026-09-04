/**
 * v1.9 R-04-3: confirmation shown before a "send to terminal" whose
 * collected file count or total size exceeds the configurable threshold —
 * the safety gate for R-02's backlink recursion pulling in more than the
 * user expects. Static structure only, same pattern as `removeDeviceModal.ts`.
 */

import type { App } from 'obsidian';
import { Modal } from 'obsidian';

import { t } from '../../i18n';
import { formatBytes } from '../../services/remote/noteCollector.ts';

export class TransferConfirmModal extends Modal {
  private readonly fileCount: number;
  private readonly totalBytes: number;
  private resolved = false;
  private resolve: ((proceed: boolean) => void) | null = null;

  constructor(app: App, fileCount: number, totalBytes: number) {
    super(app);
    this.fileCount = fileCount;
    this.totalBytes = totalBytes;
  }

  /** Resolves true when the user confirms, false on cancel or dismissal. */
  static confirm(app: App, fileCount: number, totalBytes: number): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new TransferConfirmModal(app, fileCount, totalBytes);
      modal.resolve = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: t('modals.transferConfirm.title') });
    this.contentEl.createEl('p', {
      text: t('modals.transferConfirm.body', {
        count: this.fileCount,
        size: formatBytes(this.totalBytes),
      }),
    });

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelButton = actions.createEl('button', { text: t('common.cancel') });
    cancelButton.addEventListener('click', () => this.close());
    const confirmButton = actions.createEl('button', { cls: 'mod-cta', text: t('modals.transferConfirm.sendAnyway') });
    confirmButton.addEventListener('click', () => {
      this.settle(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }

  private settle(proceed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve?.(proceed);
  }
}
