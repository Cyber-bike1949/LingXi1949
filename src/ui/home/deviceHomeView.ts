import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, Menu, Notice, setIcon, setTooltip } from 'obsidian';

import type TerminalPlugin from '../../main';
import { t } from '../../i18n';
import { buildDeviceHomeCards, getRefreshNodeIds, type DeviceHomeCard } from '../../services/remote/deviceHomeModel';
import { pairDevice, type PairDeviceResult } from '../../services/remote/devicePairing';
import type { Disposable } from '../../services/remote/transport';
import { ShortcutGroupStore, type ShortcutGroup } from '../../services/terminal/shortcutGroupStore';
import { OperationHistoryModal } from '../terminal/operationHistoryModal';
import { AddDeviceModal } from './addDeviceModal';
import { RemoveDeviceModal } from './removeDeviceModal';

export const DEVICE_HOME_VIEW_TYPE = 'termesh-device-home';

export class DeviceHomeView extends ItemView {
  private readonly plugin: TerminalPlugin;
  private connectionSubscription: Disposable | null = null;
  private runtimeProgressCleanup: (() => void) | null = null;
  private shortcutGroupsCleanup: (() => void) | null = null;
  private renderTimer: number | null = null;
  private refreshing = false;

  constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DEVICE_HOME_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t('plugin.name');
  }

  getIcon(): string {
    return 'monitor-dot';
  }

  onOpen(): Promise<void> {
    const connections = this.plugin.getDeviceConnectionManager();
    this.connectionSubscription = connections.onDidChange(() => this.scheduleRender());
    this.runtimeProgressCleanup = this.plugin.onIrohRuntimeInstallProgressChange(() => this.scheduleRender());
    this.shortcutGroupsCleanup = this.plugin.onShortcutGroupsChange(() => this.scheduleRender());
    this.render();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.connectionSubscription?.dispose();
    this.connectionSubscription = null;
    this.runtimeProgressCleanup?.();
    this.runtimeProgressCleanup = null;
    this.shortcutGroupsCleanup?.();
    this.shortcutGroupsCleanup = null;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    return Promise.resolve();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('termesh-device-home');

    const header = container.createDiv({ cls: 'termesh-home-header' });
    const heading = header.createDiv({ cls: 'termesh-home-heading' });
    heading.createEl('h1', { text: t('home.title') });
    heading.createEl('p', { text: t('home.description') });

    const refreshButton = header.createEl('button', {
      cls: 'clickable-icon termesh-home-refresh',
      attr: { 'aria-label': this.refreshing ? t('home.refreshing') : t('home.refresh') },
    });
    setIcon(refreshButton, 'refresh-cw');
    setTooltip(refreshButton, this.refreshing ? t('home.refreshing') : t('home.refresh'));
    refreshButton.disabled = this.refreshing;
    refreshButton.toggleClass('is-refreshing', this.refreshing);
    refreshButton.addEventListener('click', () => { void this.refreshDevices(); });

    const connections = this.plugin.getDeviceConnectionManager();
    const cards = buildDeviceHomeCards(this.plugin.getPairedDeviceStore().list(), connections);
    const grid = container.createDiv({ cls: 'termesh-device-grid' });
    for (const card of cards) this.renderCard(grid, card);
  }

  private renderCard(grid: HTMLElement, card: DeviceHomeCard): void {
    if (card.kind === 'add') {
      const cardEl = this.createInteractiveCard(grid, 'termesh-device-card is-add', t('home.addDevice'), () => {
        this.openAddDeviceModal();
      });
      const icon = cardEl.createDiv({ cls: 'termesh-device-icon' });
      setIcon(icon, 'plus');
      cardEl.createEl('h2', { text: t('home.addDevice') });
      cardEl.createEl('p', { text: t('home.addDeviceDescription') });
      return;
    }

    if (card.kind === 'local') {
      const cardEl = this.createInteractiveCard(grid, 'termesh-device-card is-local', t('home.openTerminal'), () => {
        void this.plugin.openLocalDeviceTerminal();
      });
      const top = cardEl.createDiv({ cls: 'termesh-device-card-top' });
      const identity = top.createDiv({ cls: 'termesh-device-identity' });
      const icon = identity.createDiv({ cls: 'termesh-device-icon' });
      setIcon(icon, 'monitor');
      const meta = identity.createDiv({ cls: 'termesh-device-meta' });
      meta.createEl('h2', { text: t('home.localDevice') });
      this.renderStatus(meta, 'connected', t('home.available'));
      const groups = this.plugin.settings.deviceShortcutGroups
        .filter((group) => group.deviceKey === 'local')
        .sort((a, b) => b.creationOrder - a.creationOrder);
      cardEl.createEl('p', { text: t('home.localDeviceDescription') });
      this.renderDeviceShortcuts(cardEl, groups, (group) => this.plugin.runShortcutGroupOnLocalDevice(group), true, 'local');
      return;
    }

    const { device, status } = card;
    const statusText = this.getRemoteStatusText(status.state);
    const cardEl = this.createInteractiveCard(
      grid,
      `termesh-device-card is-remote status-${status.state}`,
      `${device.name}: ${statusText}`,
      () => {
        if (status.state !== 'connecting') void this.openRemoteTerminal(device.nodeId);
      },
      status.state === 'connecting',
    );
    const top = cardEl.createDiv({ cls: 'termesh-device-card-top' });
    const identity = top.createDiv({ cls: 'termesh-device-identity' });
    const icon = identity.createDiv({ cls: 'termesh-device-icon' });
    setIcon(icon, 'server');
    const meta = identity.createDiv({ cls: 'termesh-device-meta' });
    const name = meta.createEl('h2', { text: device.name });
    this.renderStatus(meta, status.state, statusText);
    const lastConnected = device.lastConnectedAt
      ? t('home.lastConnected', { time: this.formatLastConnectedAt(device.lastConnectedAt) })
      : t('home.neverConnected');
    setTooltip(icon, lastConnected);
    setTooltip(name, lastConnected);

    const more = top.createEl('button', {
      cls: 'clickable-icon termesh-device-more',
      attr: { 'aria-label': t('home.moreActions') },
    });
    setIcon(more, 'ellipsis');
    setTooltip(more, t('home.moreActions'));
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = new Menu();
      if (status.state === 'connected') {
        menu.addItem((item) => item.setTitle(t('home.disconnect')).setIcon('unplug').onClick(() => {
          this.plugin.getDeviceConnectionManager().disconnect(device.nodeId);
        }));
      }
      menu.addItem((item) => item.setTitle(t('home.removeDevice')).setIcon('trash-2').onClick(() => {
        new RemoveDeviceModal(this.app, device.name, async () => {
          this.plugin.getDeviceConnectionManager().disconnect(device.nodeId);
          this.plugin.getPairedDeviceStore().remove(device.nodeId);
          this.plugin.handleDeviceRemoved(device.nodeId);
          await this.plugin.saveSettings();
          new Notice(t('home.deviceRemoved'));
          this.render();
        }).open();
      }));
      menu.showAtMouseEvent(event);
    });

    const groups = this.plugin.settings.deviceShortcutGroups
      .filter((group) => group.deviceKey === device.nodeId)
      .sort((a, b) => b.creationOrder - a.creationOrder);
    cardEl.createEl('p', {
      text: status.state === 'connected' ? '点击卡片空白处打开新终端' : '点击连接并打开终端',
    });
    if (status.state === 'error') {
      cardEl.createDiv({
        cls: 'termesh-device-error',
        text: status.code === 'CONTROLLER_ALREADY_CONNECTED'
          ? t('home.controllerAlreadyConnected')
          : status.message,
      });
    }
    this.renderDeviceShortcuts(
      cardEl,
      groups,
      (group) => this.plugin.runShortcutGroupOnDevice(device.nodeId, group),
      status.state === 'connected',
      device.nodeId,
    );
  }

  private renderDeviceShortcuts(
    parent: HTMLElement,
    groups: ShortcutGroup[],
    run: (group: ShortcutGroup) => Promise<void>,
    enabled: boolean,
    deviceKey: string,
  ): void {
    if (groups.length === 0) return;
    parent.createDiv({ cls: 'termesh-device-shortcut-label', text: '快捷命令' });
    const shortcuts = parent.createDiv({ cls: 'termesh-device-shortcuts' });
    const latest = shortcuts.createEl('button', {
      cls: 'termesh-device-shortcut-latest',
      attr: { title: groups[0].name, 'aria-label': `运行快捷组：${groups[0].name}` },
    });
    setIcon(latest.createSpan('termesh-device-shortcut-icon'), 'play');
    latest.createSpan({ cls: 'termesh-device-shortcut-name', text: groups[0].name });
    latest.disabled = !enabled;
    latest.addEventListener('click', (event) => {
      event.stopPropagation();
      void run(groups[0]).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : '快捷组启动失败');
      });
    });

    const toggle = shortcuts.createEl('button', {
      cls: 'clickable-icon termesh-device-shortcut-toggle',
      attr: { 'aria-label': '展开其它命令组' },
    });
    setIcon(toggle, 'chevron-down');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = new Menu();
      for (const group of groups.slice(1)) {
        menu.addItem((item) => item.setTitle(group.name).setIcon('play').setDisabled(!enabled).onClick(() => {
          void run(group).catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : '快捷组启动失败');
          });
        }));
      }
      if (groups.length > 1) menu.addSeparator();
      menu.addItem((item) => item.setTitle('管理命令组…').setIcon('list-plus').onClick(() => {
        void this.openShortcutGroupManager(deviceKey);
      }));
      menu.showAtMouseEvent(event);
    });
  }

  private async openShortcutGroupManager(deviceKey: string): Promise<void> {
    const store = new ShortcutGroupStore(
      () => Promise.resolve({ deviceShortcutGroups: this.plugin.settings.deviceShortcutGroups }),
      (data) => this.plugin.saveShortcutGroups(data.deviceShortcutGroups ?? []),
    );
    await store.load();
    new OperationHistoryModal(this.app, [], deviceKey, store, { initialTab: 'groups' }).open();
  }

  private createInteractiveCard(
    parent: HTMLElement,
    className: string,
    label: string,
    activate: () => void,
    disabled = false,
  ): HTMLElement {
    const card = parent.createDiv({ cls: className });
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', label);
    card.setAttribute('tabindex', disabled ? '-1' : '0');
    card.toggleClass('is-disabled', disabled);
    card.addEventListener('click', (event) => {
      if (!disabled && !(event.target as HTMLElement).closest('button')) activate();
    });
    card.addEventListener('keydown', (event) => {
      if (!disabled && event.target === card && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        activate();
      }
    });
    return card;
  }

  private renderStatus(parent: HTMLElement, state: string, label: string): void {
    const status = parent.createDiv({ cls: `termesh-device-status status-${state}` });
    status.createSpan({ cls: 'termesh-status-dot' });
    status.createSpan({ text: label });
  }

  private openAddDeviceModal(): void {
    new AddDeviceModal(this.app, {
      addDevice: (code, name) => this.addDevice(code, name),
      onAdded: () => {
        new Notice(t('home.deviceAdded'));
        this.render();
      },
    }).open();
  }

  private async addDevice(code: string, name: string): Promise<PairDeviceResult> {
    const module = await this.plugin.loadIroh();
    const result = pairDevice(
      this.plugin.getPairedDeviceStore(),
      (normalizedCode) => ({
        nodeId: module.EndpointTicket.fromString(normalizedCode).endpointAddr().id().toString(),
      }),
      code,
      name,
    );
    if (result.ok) await this.plugin.saveSettings();
    return result;
  }

  private async openRemoteTerminal(nodeId: string): Promise<void> {
    try {
      await this.plugin.openRemoteTerminal(nodeId, this.plugin.getActiveNoteName());
    } catch (error) {
      new Notice(t('home.operationFailed', {
        message: error instanceof Error ? error.message : String(error),
      }), 7000);
    }
  }

  private async refreshDevices(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.render();
    const connections = this.plugin.getDeviceConnectionManager();
    const cards = buildDeviceHomeCards(this.plugin.getPairedDeviceStore().list(), connections);
    await Promise.allSettled(getRefreshNodeIds(cards).map((nodeId) => connections.connect(nodeId)));
    this.refreshing = false;
    this.render();
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.contentEl.isConnected) this.render();
    }, 0);
  }

  private getStatusText(state: 'disconnected' | 'connecting' | 'connected' | 'error'): string {
    switch (state) {
      case 'disconnected': return t('home.statusDisconnected');
      case 'connecting': return t('home.statusConnecting');
      case 'connected': return t('home.statusConnected');
      case 'error': return t('home.statusError');
    }
  }

  private getRemoteStatusText(state: 'disconnected' | 'connecting' | 'connected' | 'error'): string {
    if (state !== 'connecting') return this.getStatusText(state);

    const runtimeProgress = this.plugin.getIrohRuntimeInstallProgress();
    if (runtimeProgress?.stage === 'downloading') {
      const percent = runtimeProgress.percent === undefined ? '' : ` ${Math.round(runtimeProgress.percent)}%`;
      return `${t('notices.downloadingRemoteRuntime')}${percent}`;
    }
    if (runtimeProgress?.stage === 'verifying') {
      return t('notices.verifyingRemoteRuntime');
    }
    if (runtimeProgress?.stage === 'retrying') {
      return t('notices.retryingRemoteRuntime');
    }
    return this.getStatusText(state);
  }

  private formatLastConnectedAt(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
}
