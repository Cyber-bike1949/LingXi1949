import type { App } from 'obsidian';
import { Modal, Notice } from 'obsidian';

import { t } from '../../i18n';
import { AI_LAUNCHER_CATALOG } from '../../services/terminal/aiLauncherCatalog';
import type { DeviceAgentConfig } from '../../settings/settings';

const CUSTOM_AGENT_VALUE = '__custom__';

export interface DeviceAgentConfigModalOptions {
  deviceName: string;
  existing: DeviceAgentConfig | null;
  onSave: (config: DeviceAgentConfig) => Promise<void>;
  onRemove: () => Promise<void>;
}

/**
 * Device card "配置 Agent" form (candidate doc §6.2/§6.5, design doc §2.3.2).
 * A dedicated modal rather than extending `AddDeviceModal` inline - keeps
 * the existing pairing flow in that modal unchanged while this one owns a
 * different concern (`deviceAgentConfigs`, not `pairedDevices`).
 */
export class DeviceAgentConfigModal extends Modal {
  private readonly options: DeviceAgentConfigModalOptions;
  private agentId: string;
  private agentName: string;
  private provider: string;
  private model: string;
  private apiKey: string;
  private saveButtonEl: HTMLButtonElement | null = null;

  constructor(app: App, options: DeviceAgentConfigModalOptions) {
    super(app);
    this.options = options;
    const existing = options.existing;
    this.agentId = existing?.agentId ?? AI_LAUNCHER_CATALOG[0]?.presetId ?? CUSTOM_AGENT_VALUE;
    this.agentName = existing?.agentName ?? '';
    this.provider = existing?.provider ?? '';
    this.model = existing?.model ?? '';
    this.apiKey = existing?.apiKey ?? '';
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass('termesh-device-agent-config-modal');
    contentEl.empty();
    contentEl.createEl('h2', { text: t('home.agentConfigTitle') });
    contentEl.createEl('p', { cls: 'setting-item-description', text: this.options.deviceName });

    const agentLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    agentLabel.createSpan({ text: t('home.agentConfigAgent') });
    const agentSelect = agentLabel.createEl('select');
    for (const entry of AI_LAUNCHER_CATALOG) {
      agentSelect.createEl('option', { value: entry.presetId, text: entry.presetId });
    }
    agentSelect.createEl('option', { value: CUSTOM_AGENT_VALUE, text: t('home.agentConfigAgentCustom') });
    const isKnownAgent = AI_LAUNCHER_CATALOG.some((entry) => entry.presetId === this.agentId);
    agentSelect.value = isKnownAgent ? this.agentId : CUSTOM_AGENT_VALUE;
    agentSelect.addEventListener('change', () => {
      this.agentId = agentSelect.value === CUSTOM_AGENT_VALUE ? '' : agentSelect.value;
    });
    if (!isKnownAgent) this.agentId = '';

    const nameLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    nameLabel.createSpan({ text: t('home.agentConfigAgentName') });
    const nameInput = nameLabel.createEl('input', {
      type: 'text',
      placeholder: t('home.agentConfigAgentNamePlaceholder'),
      value: this.agentName,
    });
    nameInput.addEventListener('input', () => { this.agentName = nameInput.value; });

    const providerLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    providerLabel.createSpan({ text: t('home.agentConfigProvider') });
    const providerInput = providerLabel.createEl('input', {
      type: 'text',
      placeholder: t('home.agentConfigProviderPlaceholder'),
      value: this.provider,
    });
    providerInput.addEventListener('input', () => { this.provider = providerInput.value; });

    const modelLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    modelLabel.createSpan({ text: t('home.agentConfigModel') });
    const modelInput = modelLabel.createEl('input', {
      type: 'text',
      placeholder: t('home.agentConfigModelPlaceholder'),
      value: this.model,
    });
    modelInput.addEventListener('input', () => { this.model = modelInput.value; });

    const apiKeyLabel = contentEl.createEl('label', { cls: 'termesh-form-field' });
    apiKeyLabel.createSpan({ text: t('home.agentConfigApiKey') });
    const apiKeyInput = apiKeyLabel.createEl('input', {
      type: 'password',
      placeholder: t('home.agentConfigApiKeyPlaceholder'),
      value: this.apiKey,
    });
    apiKeyInput.addEventListener('input', () => { this.apiKey = apiKeyInput.value; });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    if (this.options.existing) {
      const removeButton = buttons.createEl('button', { cls: 'mod-warning', text: t('home.agentConfigRemove') });
      removeButton.addEventListener('click', () => { void this.remove(); });
    }
    const cancelButton = buttons.createEl('button', { text: t('common.cancel') });
    cancelButton.addEventListener('click', () => this.close());
    this.saveButtonEl = buttons.createEl('button', { cls: 'mod-cta', text: t('home.agentConfigSave') });
    this.saveButtonEl.addEventListener('click', () => { void this.save(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    if (!this.saveButtonEl) return;
    const agentId = this.agentId.trim();
    if (!agentId) {
      new Notice(t('home.agentConfigAgentNamePlaceholder'));
      return;
    }
    this.saveButtonEl.disabled = true;
    try {
      await this.options.onSave({
        agentId,
        agentName: this.agentName.trim() || agentId,
        provider: this.provider.trim(),
        model: this.model.trim(),
        apiKey: this.apiKey.trim() ? this.apiKey.trim() : null,
      });
      new Notice(t('home.agentConfigSaved'));
      this.close();
    } finally {
      if (this.saveButtonEl) this.saveButtonEl.disabled = false;
    }
  }

  private async remove(): Promise<void> {
    await this.options.onRemove();
    new Notice(t('home.agentConfigRemoved'));
    this.close();
  }
}
