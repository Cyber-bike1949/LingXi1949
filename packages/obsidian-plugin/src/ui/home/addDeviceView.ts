import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice } from 'obsidian';

import type TerminalPlugin from '../../main';
import { t } from '../../i18n';
import { pairDevice } from '../../services/remote/devicePairing';
import type { ConnectionCodeProblem } from '../../services/remote/connectionCode';

export const DEVICE_PAIRING_VIEW_TYPE = 'termesh-device-pairing';

/** Persistent workspace form for pairing another LingXi Agent. */
export class AddDeviceView extends ItemView {
  private readonly plugin: TerminalPlugin;
  private deviceName = '';
  private connectionCode = '';
  private codeInputEl: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;
  private submitButtonEl: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return DEVICE_PAIRING_VIEW_TYPE; }
  getDisplayText(): string { return t('home.addDevice'); }
  getIcon(): string { return 'monitor-plus'; }

  onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('termesh-add-device-view');
    contentEl.createEl('h2', { text: t('home.addDevice') });
    contentEl.createEl('p', { text: t('home.addDeviceDescription') });

    const nameLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    nameLabel.createSpan({ text: t('home.deviceName') });
    const nameInput = nameLabel.createEl('input', {
      type: 'text',
      placeholder: t('home.deviceNamePlaceholder'),
    });
    nameInput.addEventListener('input', () => { this.deviceName = nameInput.value; });

    const codeLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    codeLabel.createSpan({ text: t('home.connectionCode') });
    this.codeInputEl = codeLabel.createEl('textarea', {
      placeholder: t('home.connectionCodePlaceholder'),
      attr: { rows: '5' },
    });
    this.codeInputEl.addEventListener('input', () => {
      this.connectionCode = this.codeInputEl?.value ?? '';
      this.setError(null);
    });

    this.errorEl = contentEl.createDiv({ cls: 'termesh-form-error' });
    this.errorEl.setAttribute('role', 'alert');
    this.submitButtonEl = contentEl.createEl('button', {
      cls: 'mod-cta',
      text: t('home.addDevice'),
    });
    this.submitButtonEl.addEventListener('click', () => { void this.submit(); });

    window.setTimeout(() => this.codeInputEl?.focus(), 0);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async submit(): Promise<void> {
    if (!this.submitButtonEl) return;
    this.submitButtonEl.disabled = true;
    this.submitButtonEl.setText(t('home.addingDevice'));
    this.setError(null);
    try {
      const module = await this.plugin.loadIroh();
      const result = pairDevice(
        this.plugin.getPairedDeviceStore(),
        (normalizedCode) => ({
          nodeId: module.EndpointTicket.fromString(normalizedCode).endpointAddr().id().toString(),
        }),
        this.connectionCode,
        this.deviceName,
      );
      if (!result.ok) {
        this.setError(this.getPairingProblemMessage(result.problem));
        this.codeInputEl?.focus();
        return;
      }
      await this.plugin.saveSettings();
      new Notice(t('home.deviceAdded'));
      await this.plugin.activateDeviceHome();
    } catch (error) {
      this.setError(t('home.operationFailed', {
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (this.submitButtonEl) {
        this.submitButtonEl.disabled = false;
        this.submitButtonEl.setText(t('home.addDevice'));
      }
    }
  }

  private setError(message: string | null): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message ?? '');
    this.errorEl.toggleClass('is-visible', message !== null);
  }

  private getPairingProblemMessage(problem: ConnectionCodeProblem | 'unparseable'): string {
    switch (problem) {
      case 'empty': return t('home.pairEmpty');
      case 'wrong-prefix': return t('home.pairWrongPrefix');
      case 'bad-characters': return t('home.pairBadCharacters');
      case 'too-short': return t('home.pairTooShort');
      case 'unparseable': return t('home.pairUnparseable');
    }
  }
}
