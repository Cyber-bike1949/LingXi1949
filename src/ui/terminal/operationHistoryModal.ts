import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { OperationRecord } from '../../services/terminal/operationHistory.ts';
import type { ShortcutGroupStore } from '../../services/terminal/shortcutGroupStore.ts';

export class OperationHistoryModal extends Modal {
  private readonly selected = new Set<string>();
  private readonly checkboxes = new Map<string, HTMLInputElement>();

  constructor(
    app: App,
    private readonly records: OperationRecord[],
    private readonly deviceKey: string,
    private readonly store: ShortcutGroupStore,
    private readonly captureEnabled = true,
    private readonly onCaptureEnabledChange?: (enabled: boolean) => void,
    private readonly onClearHistory?: () => void,
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText('历史操作');
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.records.length ? '选择要保存为快捷组的操作（按原始顺序执行）。' : '暂无可用历史操作。' });
    new Setting(this.contentEl).setName('采集历史').addToggle((toggle) => {
      toggle.setValue(this.captureEnabled).onChange((enabled) => this.onCaptureEnabledChange?.(enabled));
    });
    const list = this.contentEl.createDiv({ cls: 'operation-history-list' });
    const outputMatches = new Map<string, string>();
    for (const record of this.records) {
      const row = list.createDiv({ cls: 'operation-history-row' });
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.setAttribute('aria-label', record.summary);
      checkbox.addEventListener('change', () => checkbox.checked ? this.selected.add(record.id) : this.selected.delete(record.id));
      this.checkboxes.set(record.id, checkbox);
      row.createSpan({ text: `${record.kind}: ${record.summary}` });
      const match = row.createEl('input', {
        type: 'text',
        placeholder: '可选：匹配后续终端输出',
        attr: { 'aria-label': `${record.summary} 的输出匹配` },
      });
      match.addEventListener('input', () => outputMatches.set(record.id, match.value));
    }
    new Setting(this.contentEl).setName('快捷组名称').addText((text) => {
      text.setPlaceholder('例如：启动项目');
      text.inputEl.dataset.role = 'shortcut-name';
    });
    const actions = this.contentEl.createDiv({ cls: 'operation-history-actions' });
    const save = actions.createEl('button', { text: '保存快捷组', cls: 'mod-cta' });
    save.disabled = this.records.length === 0;
    save.addEventListener('click', () => {
      const input = this.contentEl.querySelector<HTMLInputElement>('input[data-role="shortcut-name"]');
      const name = input?.value ?? '';
      const selected = this.records.filter((record) => this.selected.has(record.id));
      void this.store.create(this.deviceKey, name, selected, outputMatches).then(() => {
        new Notice('快捷组已保存');
        this.close();
      }).catch((error: unknown) => new Notice(error instanceof Error ? error.message : '保存快捷组失败'));
    });
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const clear = actions.createEl('button', { text: '清空历史' });
    clear.disabled = this.records.length === 0;
    clear.addEventListener('click', () => {
      this.onClearHistory?.();
      this.close();
    });
  }

  onClose(): void { this.contentEl.empty(); this.checkboxes.clear(); this.selected.clear(); }
}
