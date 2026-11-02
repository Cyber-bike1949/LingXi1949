import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../i18n';
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
    actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
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
    this.titleEl.setText(t('operationHistory.title'));
    this.selectInitialGroup();
    this.render();
  }

  close(): void {
    if (!this.allowClose && this.dirty) {
      new ConfirmActionModal(
        this.app,
        t('operationHistory.discardTitle'),
        t('operationHistory.discardMessage'),
        t('operationHistory.discardConfirm'),
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
    this.createTab(tabs, 'history', t('operationHistory.historyTab'));
    this.createTab(tabs, 'groups', t('operationHistory.groupsTab'));
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
        new Notice(t('operationHistory.saveOrDiscardFirst'));
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
      text: this.records.length ? t('operationHistory.historyDescription') : t('operationHistory.historyEmpty'),
    });
    const capture = toolbar.createEl('label', { cls: 'operation-history-capture' });
    capture.createSpan({ text: t('operationHistory.captureHistory') });
    const toggle = capture.createEl('input', { type: 'checkbox' });
    toggle.checked = this.captureEnabled;
    toggle.addEventListener('change', () => {
      this.captureEnabled = toggle.checked;
      this.options.onCaptureEnabledChange?.(toggle.checked);
    });

    const list = parent.createDiv({ cls: 'operation-history-list' });
    for (const record of this.records) this.renderHistoryRow(list, record);

    const form = parent.createDiv('operation-history-create-form');
    form.createEl('label', { text: t('operationHistory.groupName'), attr: { for: 'operation-history-group-name' } });
    const name = form.createEl('input', {
      type: 'text',
      attr: { id: 'operation-history-group-name', placeholder: t('operationHistory.groupNamePlaceholder') },
    });
    const summary = form.createDiv('operation-history-selection-summary');
    const footer = parent.createDiv('operation-history-footer');
    const destructive = footer.createDiv('operation-history-footer-destructive');
    const clear = destructive.createEl('button', { text: t('operationHistory.clearHistory'), cls: 'operation-history-clear' });
    clear.disabled = this.records.length === 0;
    clear.addEventListener('click', () => this.confirmClearHistory());
    const actions = footer.createDiv('operation-history-footer-actions');
    actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: t('operationHistory.saveGroup'), cls: 'mod-cta' });
    const updateState = (): void => {
      summary.setText(t('operationHistory.selectedCount', { count: this.selected.size }));
      save.disabled = this.selected.size === 0 || name.value.trim().length === 0;
    };
    save.addEventListener('click', () => {
      const selected = this.records.filter((record) => this.selected.has(record.id));
      void this.store.create(this.deviceKey, name.value, selected, this.outputMatches).then((group) => {
        new Notice(t('operationHistory.groupSaved'));
        this.selectedGroupId = group.id;
        this.loadEditingGroup(group);
        this.activeTab = 'groups';
        this.render();
      }).catch((error: unknown) => this.showStoreError(error, t('operationHistory.saveGroupFailed')));
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
    const advanced = row.createEl('details', { cls: 'operation-history-advanced' });
    advanced.createEl('summary', { text: t('operationHistory.outputMatchOptional') });
    const match = advanced.createEl('input', { type: 'text', placeholder: t('operationHistory.outputMatchPlaceholder') });
    match.value = this.outputMatches.get(record.id) ?? '';
    match.addEventListener('input', () => this.outputMatches.set(record.id, match.value));
  }

  private renderGroups(parent: HTMLElement): void {
    const groups = this.store.list(this.deviceKey);
    if (!groups.length) {
      const empty = parent.createDiv('operation-groups-empty');
      setIcon(empty.createDiv('operation-groups-empty-icon'), 'list-plus');
      empty.createEl('h3', { text: t('operationHistory.noGroupsTitle') });
      empty.createEl('p', { text: t('operationHistory.noGroupsDescription') });
      empty.createEl('button', { text: t('operationHistory.createFromHistory') }).addEventListener('click', () => {
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
    selectorRow.createEl('label', { text: t('operationHistory.group'), attr: { for: 'operation-group-selector' } });
    const selector = selectorRow.createEl('select', { attr: { id: 'operation-group-selector' } });
    for (const group of groups) selector.createEl('option', { text: group.name, value: group.id });
    selector.value = selected.id;
    selector.addEventListener('change', () => this.selectManagedGroup(selector.value));

    const nameField = parent.createDiv('operation-group-name-field');
    nameField.createEl('label', { text: t('operationHistory.name'), attr: { for: 'operation-group-name' } });
    const name = nameField.createEl('input', { type: 'text', attr: { id: 'operation-group-name' } });
    name.value = this.editingName;
    name.addEventListener('input', () => {
      this.editingName = name.value;
      this.dirty = true;
      this.updateGroupSaveButton(parent);
    });

    const stepsHeader = parent.createDiv('operation-group-steps-header');
    stepsHeader.createEl('h3', { text: t('operationHistory.stepsCount', { count: this.editingSteps.length }) });
    stepsHeader.createEl('button', { text: t('operationHistory.addStep') }).addEventListener('click', () => {
      this.editingSteps.push(this.createEmptyStep());
      this.dirty = true;
      this.render();
    });
    const steps = parent.createDiv('operation-group-steps');
    this.editingSteps.forEach((step, index) => this.renderStepEditor(steps, step, index));

    const footer = parent.createDiv('operation-history-footer');
    const destructive = footer.createDiv('operation-history-footer-destructive');
    destructive.createEl('button', { text: t('operationHistory.deleteGroup'), cls: 'operation-history-clear' }).addEventListener('click', () => {
      this.confirmDeleteGroup(selected);
    });
    const actions = footer.createDiv('operation-history-footer-actions');
    actions.createEl('button', { text: t('operationHistory.close') }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: t('operationHistory.saveChanges'), cls: 'mod-cta operation-group-save' });
    save.addEventListener('click', () => this.saveManagedGroup());
    this.updateGroupSaveButton(parent);
  }

  private renderStepEditor(parent: HTMLElement, step: ShortcutStep, index: number): void {
    const row = parent.createDiv('operation-group-step');
    row.createSpan({ cls: 'operation-group-step-number', text: String(index + 1) });
    const fields = row.createDiv('operation-group-step-fields');
    const kind = fields.createEl('select', { attr: { 'aria-label': t('operationHistory.stepType', { number: index + 1 }) } });
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
      placeholder: step.kind === 'shell' ? t('operationHistory.shellCommandPlaceholder') : t('operationHistory.sentContentPlaceholder'),
      attr: { 'aria-label': t('operationHistory.stepContent', { number: index + 1 }) },
    });
    payload.value = step.kind === 'shell' || step.kind === 'text' ? step.payload : step.summary;
    payload.readOnly = step.kind === 'key' || step.kind === 'confirm';
    payload.addEventListener('input', () => {
      step.payload = payload.value;
      step.summary = payload.value;
      this.dirty = true;
      this.updateGroupSaveButton(this.contentEl);
    });
    const match = fields.createEl('input', {
      type: 'text',
      placeholder: t('operationHistory.outputMatchOptional'),
      attr: { 'aria-label': t('operationHistory.stepOutputMatch', { number: index + 1 }) },
    });
    match.value = step.outputMatch ?? '';
    match.addEventListener('input', () => {
      step.outputMatch = match.value;
      this.dirty = true;
    });
    const controls = row.createDiv('operation-group-step-controls');
    this.createStepButton(controls, 'arrow-up', t('operationHistory.moveStepUp', { number: index + 1 }), index === 0, () => this.moveStep(index, -1));
    this.createStepButton(controls, 'arrow-down', t('operationHistory.moveStepDown', { number: index + 1 }), index === this.editingSteps.length - 1, () => this.moveStep(index, 1));
    this.createStepButton(controls, 'trash-2', t('operationHistory.deleteStep', { number: index + 1 }), false, () => {
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
      new Notice(t('operationHistory.groupUpdated'));
      this.render();
    }).catch((error: unknown) => this.showStoreError(error, t('operationHistory.saveChangesFailed')));
  }

  private confirmClearHistory(): void {
    new ConfirmActionModal(
      this.app,
      t('operationHistory.clearHistoryTitle'),
      t('operationHistory.clearHistoryMessage'),
      t('operationHistory.clearHistory'),
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
      t('operationHistory.deleteGroupTitle'),
      t('operationHistory.deleteGroupMessage', { name: group.name }),
      t('operationHistory.deleteGroup'),
      () => {
        void this.store.remove(group.id).then(() => {
          this.dirty = false;
          this.selectedGroupId = this.store.list(this.deviceKey)[0]?.id ?? null;
          this.selectInitialGroup();
          new Notice(t('operationHistory.groupDeleted'));
          this.render();
        }).catch((error: unknown) => this.showStoreError(error, t('operationHistory.deleteGroupFailed')));
      },
    ).open();
  }

  private selectManagedGroup(id: string): void {
    const group = this.store.list(this.deviceKey).find((item) => item.id === id);
    if (!group) return;
    if (this.dirty) {
      new ConfirmActionModal(
        this.app,
        t('operationHistory.switchGroupTitle'),
        t('operationHistory.switchGroupMessage'),
        t('operationHistory.switchGroupConfirm'),
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
      case 'text': return t('operationHistory.kindInput');
      case 'key': return t('operationHistory.kindKey');
      case 'confirm': return t('operationHistory.kindConfirm');
    }
  }

  private showStoreError(error: unknown, fallback: string): void {
    const code = error instanceof Error ? error.message : '';
    const message = code === 'EMPTY_NAME' ? t('operationHistory.emptyName')
      : code === 'EMPTY_SELECTION' ? t('operationHistory.emptySelection')
        : code === 'DUPLICATE_NAME' ? t('operationHistory.duplicateName')
          : code === 'EMPTY_STEPS' ? t('operationHistory.emptySteps')
            : code === 'EMPTY_STEP' ? t('operationHistory.emptyStep')
              : fallback;
    new Notice(message);
  }
}
