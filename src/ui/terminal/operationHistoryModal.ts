import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { OperationKind, OperationRecord } from '../../services/terminal/operationHistory.ts';
import type { ShortcutGroup, ShortcutGroupStore, ShortcutStep } from '../../services/terminal/shortcutGroupStore.ts';

type HistoryModalTab = 'history' | 'groups';

class ConfirmActionModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => void,
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.message });
    const actions = this.contentEl.createDiv('operation-history-confirm-actions');
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const confirm = actions.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
    confirm.addEventListener('click', () => {
      this.onConfirm();
      this.close();
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

export interface OperationHistoryModalOptions {
  initialTab?: HistoryModalTab;
  captureEnabled?: boolean;
  onCaptureEnabledChange?: (enabled: boolean) => void;
  onClearHistory?: () => void;
}

export class OperationHistoryModal extends Modal {
  private readonly selected = new Set<string>();
  private readonly outputMatches = new Map<string, string>();
  private activeTab: HistoryModalTab;
  private selectedGroupId: string | null = null;
  private editingName = '';
  private editingSteps: ShortcutStep[] = [];
  private dirty = false;
  private allowClose = false;
  private captureEnabled: boolean;

  constructor(
    app: App,
    private readonly records: OperationRecord[],
    private readonly deviceKey: string,
    private readonly store: ShortcutGroupStore,
    private readonly options: OperationHistoryModalOptions = {},
  ) {
    super(app);
    this.activeTab = options.initialTab ?? 'history';
    this.captureEnabled = options.captureEnabled ?? true;
  }

  onOpen(): void {
    this.titleEl.setText('历史操作与命令组');
    this.selectInitialGroup();
    this.render();
  }

  close(): void {
    if (!this.allowClose && this.dirty) {
      new ConfirmActionModal(
        this.app,
        '放弃未保存的修改？',
        '当前命令组有尚未保存的修改。',
        '放弃修改',
        () => this.finishClose(),
      ).open();
      return;
    }
    super.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.selected.clear();
    this.outputMatches.clear();
  }

  private finishClose(): void {
    this.allowClose = true;
    super.close();
  }

  private render(): void {
    this.contentEl.empty();
    const tabs = this.contentEl.createDiv({ cls: 'operation-history-tabs', attr: { role: 'tablist' } });
    this.createTab(tabs, 'history', '操作历史');
    this.createTab(tabs, 'groups', '命令组管理');
    const panel = this.contentEl.createDiv({ cls: 'operation-history-panel', attr: { role: 'tabpanel' } });
    if (this.activeTab === 'history') this.renderHistory(panel);
    else this.renderGroups(panel);
  }

  private createTab(parent: HTMLElement, tab: HistoryModalTab, label: string): void {
    const button = parent.createEl('button', {
      text: label,
      cls: this.activeTab === tab ? 'is-active' : '',
      attr: { role: 'tab', 'aria-selected': String(this.activeTab === tab) },
    });
    button.addEventListener('click', () => {
      if (tab === this.activeTab) return;
      if (this.dirty) {
        new Notice('请先保存或放弃当前命令组修改');
        return;
      }
      this.activeTab = tab;
      this.selectInitialGroup();
      this.render();
    });
  }

  private renderHistory(parent: HTMLElement): void {
    const toolbar = parent.createDiv('operation-history-toolbar');
    toolbar.createDiv({
      cls: 'operation-history-description',
      text: this.records.length ? '选择操作并按原始顺序保存为命令组。' : '暂无可用历史操作。',
    });
    const capture = toolbar.createEl('label', { cls: 'operation-history-capture' });
    capture.createSpan({ text: '采集历史' });
    const toggle = capture.createEl('input', { type: 'checkbox' });
    toggle.checked = this.captureEnabled;
    toggle.addEventListener('change', () => {
      this.captureEnabled = toggle.checked;
      this.options.onCaptureEnabledChange?.(toggle.checked);
    });

    const list = parent.createDiv({ cls: 'operation-history-list' });
    for (const record of this.records) this.renderHistoryRow(list, record);

    const form = parent.createDiv('operation-history-create-form');
    form.createEl('label', { text: '命令组名称', attr: { for: 'operation-history-group-name' } });
    const name = form.createEl('input', {
      type: 'text',
      attr: { id: 'operation-history-group-name', placeholder: '例如：启动 Claude' },
    });
    const summary = form.createDiv('operation-history-selection-summary');
    const footer = parent.createDiv('operation-history-footer');
    const destructive = footer.createDiv('operation-history-footer-destructive');
    const clear = destructive.createEl('button', { text: '清空历史', cls: 'operation-history-clear' });
    clear.disabled = this.records.length === 0;
    clear.addEventListener('click', () => this.confirmClearHistory());
    const actions = footer.createDiv('operation-history-footer-actions');
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存命令组', cls: 'mod-cta' });
    const updateState = (): void => {
      summary.setText(`已选择 ${this.selected.size} 项，将按时间顺序执行`);
      save.disabled = this.selected.size === 0 || name.value.trim().length === 0;
    };
    save.addEventListener('click', () => {
      const selected = this.records.filter((record) => this.selected.has(record.id));
      void this.store.create(this.deviceKey, name.value, selected, this.outputMatches).then((group) => {
        new Notice('命令组已保存');
        this.selectedGroupId = group.id;
        this.loadEditingGroup(group);
        this.activeTab = 'groups';
        this.render();
      }).catch((error: unknown) => this.showStoreError(error, '保存命令组失败'));
    });
    name.addEventListener('input', updateState);
    list.addEventListener('change', updateState);
    updateState();
  }

  private renderHistoryRow(parent: HTMLElement, record: OperationRecord): void {
    const row = parent.createDiv('operation-history-row');
    const main = row.createEl('label', { cls: 'operation-history-row-main' });
    const checkbox = main.createEl('input', { type: 'checkbox', attr: { 'aria-label': record.summary } });
    checkbox.checked = this.selected.has(record.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.selected.add(record.id);
      else this.selected.delete(record.id);
    });
    main.createSpan({ cls: `operation-history-kind is-${record.kind}`, text: this.kindLabel(record.kind) });
    main.createSpan({ cls: 'operation-history-summary', text: record.summary });
    main.createSpan({ cls: 'operation-history-time', text: new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  }

  private renderGroups(parent: HTMLElement): void {
    const groups = this.store.list(this.deviceKey);
    if (!groups.length) {
      const empty = parent.createDiv('operation-groups-empty');
      setIcon(empty.createDiv('operation-groups-empty-icon'), 'list-plus');
      empty.createEl('h3', { text: '还没有命令组' });
      empty.createEl('p', { text: '从“操作历史”中选择记录并保存，即可在这里继续编辑。' });
      empty.createEl('button', { text: '从历史创建' }).addEventListener('click', () => {
        this.activeTab = 'history';
        this.render();
      });
      return;
    }

    const selected = groups.find((group) => group.id === this.selectedGroupId) ?? groups[0];
    if (selected.id !== this.selectedGroupId) {
      this.selectedGroupId = selected.id;
      this.loadEditingGroup(selected);
    }
    const selectorRow = parent.createDiv('operation-groups-selector-row');
    selectorRow.createEl('label', { text: '命令组', attr: { for: 'operation-group-selector' } });
    const selector = selectorRow.createEl('select', { attr: { id: 'operation-group-selector' } });
    for (const group of groups) selector.createEl('option', { text: group.name, value: group.id });
    selector.value = selected.id;
    selector.addEventListener('change', () => this.selectManagedGroup(selector.value));

    const nameField = parent.createDiv('operation-group-name-field');
    nameField.createEl('label', { text: '名称', attr: { for: 'operation-group-name' } });
    const name = nameField.createEl('input', { type: 'text', attr: { id: 'operation-group-name' } });
    name.value = this.editingName;
    name.addEventListener('input', () => {
      this.editingName = name.value;
      this.dirty = true;
      this.updateGroupSaveButton(parent);
    });

    const stepsHeader = parent.createDiv('operation-group-steps-header');
    stepsHeader.createEl('h3', { text: `命令步骤（${this.editingSteps.length}）` });
    stepsHeader.createEl('button', { text: '＋ 新增步骤' }).addEventListener('click', () => {
      this.editingSteps.push(this.createEmptyStep());
      this.dirty = true;
      this.render();
    });
    const steps = parent.createDiv('operation-group-steps');
    this.editingSteps.forEach((step, index) => this.renderStepEditor(steps, step, index));

    const footer = parent.createDiv('operation-history-footer');
    const destructive = footer.createDiv('operation-history-footer-destructive');
    destructive.createEl('button', { text: '删除命令组', cls: 'operation-history-clear' }).addEventListener('click', () => {
      this.confirmDeleteGroup(selected);
    });
    const actions = footer.createDiv('operation-history-footer-actions');
    actions.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存修改', cls: 'mod-cta operation-group-save' });
    save.addEventListener('click', () => this.saveManagedGroup());
    this.updateGroupSaveButton(parent);
  }

  private renderStepEditor(parent: HTMLElement, step: ShortcutStep, index: number): void {
    const row = parent.createDiv('operation-group-step');
    row.createSpan({ cls: 'operation-group-step-number', text: String(index + 1) });
    const fields = row.createDiv('operation-group-step-fields');
    const kind = fields.createEl('select', { attr: { 'aria-label': `步骤 ${index + 1} 类型` } });
    const kinds: OperationKind[] = ['shell', 'text', 'key', 'confirm'];
    for (const value of kinds) kind.createEl('option', { text: this.kindLabel(value), value });
    kind.value = step.kind;
    kind.addEventListener('change', () => {
      const nextKind = kind.value as OperationKind;
      step.kind = nextKind;
      if (nextKind === 'confirm') {
        step.payload = '\r';
        step.summary = 'Enter';
      } else if (nextKind === 'key') {
        step.payload = '\x1b';
        step.summary = 'Escape';
      } else {
        step.payload = '';
        step.summary = '';
      }
      this.dirty = true;
      this.render();
    });
    const payload = fields.createEl('input', {
      type: 'text',
      placeholder: step.kind === 'shell' ? '输入 Shell 命令' : '输入发送内容',
      attr: { 'aria-label': `步骤 ${index + 1} 内容` },
    });
    payload.value = step.kind === 'shell' || step.kind === 'text' ? step.payload : step.summary;
    payload.readOnly = step.kind === 'key' || step.kind === 'confirm';
    payload.addEventListener('input', () => {
      step.payload = payload.value;
      step.summary = payload.value;
      this.dirty = true;
      this.updateGroupSaveButton(this.contentEl);
    });
    const controls = row.createDiv('operation-group-step-controls');
    this.createStepButton(controls, 'arrow-up', `上移步骤 ${index + 1}`, index === 0, () => this.moveStep(index, -1));
    this.createStepButton(controls, 'arrow-down', `下移步骤 ${index + 1}`, index === this.editingSteps.length - 1, () => this.moveStep(index, 1));
    this.createStepButton(controls, 'trash-2', `删除步骤 ${index + 1}`, false, () => {
      this.editingSteps.splice(index, 1);
      this.dirty = true;
      this.render();
    });
  }

  private createStepButton(parent: HTMLElement, icon: string, label: string, disabled: boolean, action: () => void): void {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
    button.disabled = disabled;
    setIcon(button, icon);
    button.addEventListener('click', action);
  }

  private moveStep(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.editingSteps.length) return;
    const [step] = this.editingSteps.splice(index, 1);
    this.editingSteps.splice(target, 0, step);
    this.dirty = true;
    this.render();
  }

  private saveManagedGroup(): void {
    if (!this.selectedGroupId) return;
    void this.store.update(this.selectedGroupId, this.editingName, this.editingSteps).then((group) => {
      this.loadEditingGroup(group);
      new Notice('命令组已更新');
      this.render();
    }).catch((error: unknown) => this.showStoreError(error, '保存修改失败'));
  }

  private confirmClearHistory(): void {
    new ConfirmActionModal(
      this.app,
      '清空历史操作？',
      '这会清空当前终端的历史操作，但不会删除已经保存的命令组。',
      '清空历史',
      () => {
        this.options.onClearHistory?.();
        this.records.splice(0);
        this.selected.clear();
        this.render();
      },
    ).open();
  }

  private confirmDeleteGroup(group: ShortcutGroup): void {
    new ConfirmActionModal(
      this.app,
      '删除命令组？',
      `将删除“${group.name}”，此操作无法撤销。`,
      '删除命令组',
      () => {
        void this.store.remove(group.id).then(() => {
          this.dirty = false;
          this.selectedGroupId = this.store.list(this.deviceKey)[0]?.id ?? null;
          this.selectInitialGroup();
          new Notice('命令组已删除');
          this.render();
        }).catch((error: unknown) => this.showStoreError(error, '删除命令组失败'));
      },
    ).open();
  }

  private selectManagedGroup(id: string): void {
    const group = this.store.list(this.deviceKey).find((item) => item.id === id);
    if (!group) return;
    if (this.dirty) {
      new ConfirmActionModal(
        this.app,
        '切换命令组？',
        '当前修改尚未保存，切换后会丢失这些修改。',
        '放弃并切换',
        () => {
          this.selectedGroupId = id;
          this.loadEditingGroup(group);
          this.render();
        },
      ).open();
      this.render();
      return;
    }
    this.selectedGroupId = id;
    this.loadEditingGroup(group);
    this.render();
  }

  private selectInitialGroup(): void {
    if (this.activeTab !== 'groups') return;
    const groups = this.store.list(this.deviceKey);
    const group = groups.find((item) => item.id === this.selectedGroupId) ?? groups[0];
    if (group && (!this.editingSteps.length || this.selectedGroupId !== group.id)) {
      this.selectedGroupId = group.id;
      this.loadEditingGroup(group);
    }
  }

  private loadEditingGroup(group: ShortcutGroup): void {
    this.editingName = group.name;
    this.editingSteps = group.steps.map((step) => ({ ...step }));
    this.dirty = false;
  }

  private createEmptyStep(): ShortcutStep {
    return {
      id: `shortcut-step:${crypto.randomUUID()}`,
      kind: 'shell',
      summary: '',
      payload: '',
      captureQuality: 'manual',
      completion: 'manual',
      sequence: this.editingSteps.length + 1,
    };
  }

  private updateGroupSaveButton(parent: HTMLElement): void {
    const save = parent.querySelector<HTMLButtonElement>('.operation-group-save');
    if (save) save.disabled = !this.dirty || !this.editingName.trim() || this.editingSteps.length === 0
      || this.editingSteps.some((step) => (step.kind === 'shell' || step.kind === 'text')
        ? !step.payload.trim()
        : !step.payload);
  }

  private kindLabel(kind: OperationKind): string {
    switch (kind) {
      case 'shell': return 'Shell';
      case 'text': return '输入';
      case 'key': return '按键';
      case 'confirm': return '确认';
    }
  }

  private showStoreError(error: unknown, fallback: string): void {
    const code = error instanceof Error ? error.message : '';
    const message = code === 'EMPTY_NAME' ? '请输入命令组名称'
      : code === 'EMPTY_SELECTION' ? '请至少选择一条操作'
        : code === 'DUPLICATE_NAME' ? '当前设备已有同名命令组'
          : code === 'EMPTY_STEPS' ? '命令组至少需要一个步骤'
            : code === 'EMPTY_STEP' ? '步骤内容不能为空'
              : fallback;
    new Notice(message);
  }
}
