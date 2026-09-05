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
import alipayQrSvgMarkup from '../../assets/donate-alipay-placeholder.svg';
import { siAfdian, siBuymeacoffee, siKofi, type SimpleIcon } from 'simple-icons';
import { resolveSimpleIconColor } from '../ui/terminal/simpleIconColors';

/**
 * v1.9 R-03: overseas donation channels rendered as a brand icon + link.
 * `label` overrides the simple-icons brand title where the localized name
 * is the one users actually recognize (爱发电, a Chinese platform).
 */
const DONATE_LINKS: { icon: SimpleIcon; url: string; label?: string }[] = [
  { icon: siBuymeacoffee, url: 'https://www.buymeacoffee.com/lingxi1949' },
  { icon: siKofi, url: 'https://ko-fi.com/lingxi1949' },
  { icon: siAfdian, url: 'https://afdian.com/a/lingxi1949', label: '爱发电' },
];

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

    // Render terminal settings
    this.terminalRenderer.render(context);

    // v1.9 R-03: appended at the end of the settings page, independent of
    // the terminal renderer's existing groups.
    this.renderSupportAuthor(contentEl);
  }

  /**
   * "Support the author" section (v1.9 R-03): a static block with no
   * popups, timers, or feature-gating (R-03-3). The QR codes are inline SVG
   * bundled into main.js at build time (same convention as the LingXi logo
   * in ui/icons.ts), not an <img> pointing at a file path, so there is
   * nothing to fail to load offline (R-03-4) - the donation links are plain
   * <a> tags that simply won't navigate without a connection, which needs
   * no special handling.
   *
   * NOTE: the QR images are placeholders and the three overseas links point
   * at not-yet-verified handles - see the real assets/URLs before shipping.
   */
  private renderSupportAuthor(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'settings-card support-author-card' });
    card.createDiv({ cls: 'settings-section-title', text: t('settingsDetails.supportAuthor.title') });
    card.createEl('p', { cls: 'support-author-intro', text: t('settingsDetails.supportAuthor.intro') });

    const qrRow = card.createDiv({ cls: 'support-author-qr-row' });
    this.renderQrCode(qrRow, wechatQrSvgMarkup, t('settingsDetails.supportAuthor.wechat'));
    this.renderQrCode(qrRow, alipayQrSvgMarkup, t('settingsDetails.supportAuthor.alipay'));

    const linksRow = card.createDiv({ cls: 'support-author-links-row' });
    for (const { icon, url, label } of DONATE_LINKS) {
      this.renderDonateLink(linksRow, icon, url, label);
    }
  }

  private renderQrCode(containerEl: HTMLElement, svgMarkup: string, label: string): void {
    const item = containerEl.createDiv({ cls: 'support-author-qr-item' });
    const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').querySelector('svg');
    if (parsed) {
      item.appendChild(activeDocument.importNode(parsed, true));
    }
    item.createDiv({ cls: 'support-author-qr-label', text: label });
  }

  private renderDonateLink(containerEl: HTMLElement, icon: SimpleIcon, url: string, label?: string): void {
    const link = containerEl.createEl('a', {
      cls: 'support-author-link',
      href: url,
      text: label ?? icon.title,
    });

    const svg = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', icon.path);
    svg.appendChild(path);
    link.prepend(svg);

    const color = resolveSimpleIconColor(icon.slug, icon.hex);
    if (color) {
      link.style.setProperty('--support-author-link-color', color);
    }
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

