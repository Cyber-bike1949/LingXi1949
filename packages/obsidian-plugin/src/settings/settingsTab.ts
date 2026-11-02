/**
 * Terminal plugin settings tab
 * Provides the terminal configuration interface
 */

import type { App } from 'obsidian';
import { PluginSettingTab, setIcon } from 'obsidian';
import type TerminalPlugin from '../main';
import { TerminalSettingsRenderer } from './renderers/terminalSettingsRenderer';
import type { RendererContext } from './types';
import { t } from '../i18n';
import { createLingXiLogoSvg } from '../ui/icons';
import wechatQrSvgMarkup from '../../assets/donate-wechat-placeholder.svg';
import kofiQrDataUrl from '../../assets/donate-kofi.png';

/**
 * Terminal settings tab class
 */
export class TerminalSettingTab extends PluginSettingTab {
  plugin: TerminalPlugin;
  private terminalRenderer: TerminalSettingsRenderer;
  private expandedSections: Set<string> = new Set();

  constructor(app: App, plugin: TerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.terminalRenderer = new TerminalSettingsRenderer();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Add the main container class
    containerEl.addClass('terminal-settings-container');

    // Render the header section
    this.renderHeader(containerEl);

    // Content container
    const contentEl = containerEl.createDiv({ cls: 'terminal-settings-content' });

    // Create the renderer context
    const context: RendererContext = {
      app: this.app,
      plugin: this.plugin,
      containerEl: contentEl,
      expandedSections: this.expandedSections
    };

    // Keep the optional support card visible without requiring users to
    // scroll through the full settings page.
    this.renderSupportAuthor(contentEl);

    // Render terminal settings
    this.terminalRenderer.render(context);
  }

  /**
   * Static support section with no popups, timers, or feature gating. Both
   * QR assets are bundled into main.js so they remain available offline.
   */
  private renderSupportAuthor(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'settings-card support-author-card' });
    card.createDiv({ cls: 'settings-section-title', text: t('settingsDetails.supportAuthor.title') });
    card.createEl('p', { cls: 'support-author-intro', text: t('settingsDetails.supportAuthor.intro') });

    const qrRow = card.createDiv({ cls: 'support-author-qr-row' });
    this.renderSvgQrCode(qrRow, wechatQrSvgMarkup, t('settingsDetails.supportAuthor.wechat'));
    this.renderImageQrCode(qrRow, kofiQrDataUrl, t('settingsDetails.supportAuthor.kofi'));
  }

  private renderSvgQrCode(containerEl: HTMLElement, svgMarkup: string, label: string): void {
    const item = containerEl.createDiv({ cls: 'support-author-qr-item' });
    const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').querySelector('svg');
    if (parsed) {
      item.appendChild(activeDocument.importNode(parsed, true));
    }
    item.createDiv({ cls: 'support-author-qr-label', text: label });
  }

  private renderImageQrCode(containerEl: HTMLElement, src: string, label: string): void {
    const item = containerEl.createDiv({ cls: 'support-author-qr-item' });
    item.createEl('img', {
      attr: {
        src,
        alt: label,
        width: '140',
        height: '140',
      },
    });
    item.createDiv({ cls: 'support-author-qr-label', text: label });
  }

  /**
   * Render the header section
   */
  private renderHeader(containerEl: HTMLElement): void {
    const headerEl = containerEl.createDiv({ cls: 'terminal-settings-header settings-header' });

    // Title row (includes the icon, title, changelog button, and reload button)
    const titleRow = headerEl.createDiv({ cls: 'settings-title-row' });

    // Left side: logo + title + changelog button
    const titleGroup = titleRow.createDiv({ cls: 'settings-title-group' });
    
    // Add the LingXi logo
    const iconContainer = titleGroup.createDiv({ cls: 'settings-title-icon' });
    iconContainer.appendChild(createLingXiLogoSvg(32));

    titleGroup.createDiv({ cls: 'settings-title', text: t('settings.header.title') });

    const changelogBtn = titleGroup.createEl('button', {
      cls: 'settings-header-button settings-title-changelog-button',
    });
    changelogBtn.setAttribute('type', 'button');
    setIcon(changelogBtn, 'scroll-text');
    changelogBtn.createSpan({ text: t('settings.header.changelog') });
    changelogBtn.addEventListener('click', () => {
      this.plugin.showChangelog();
    });

    // Right side: feedback link + reload button
    const actionsGroup = titleRow.createDiv({ cls: 'settings-actions-group' });
    
    const feedbackContainer = actionsGroup.createDiv({ cls: 'settings-feedback' });
    feedbackContainer.appendText(t('settings.header.feedbackText'));
    feedbackContainer.createEl('a', {
      text: t('settings.header.feedbackLink'),
      href: 'https://github.com/Cyber-bike1949/LingXi1949'
    });
    feedbackContainer.createSpan({ cls: 'settings-feedback-separator', text: ' · ' });
    feedbackContainer.createEl('a', {
      text: t('settings.header.communityLink'),
      href: 'https://t.me/+t6oRqhaw8c1jNzE1'
    });
  }
}
