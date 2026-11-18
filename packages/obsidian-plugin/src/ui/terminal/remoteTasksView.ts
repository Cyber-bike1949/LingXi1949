import type { WorkspaceLeaf } from 'obsidian';
import { ItemView, Setting } from 'obsidian';
import type TerminalPlugin from '../../main';

export const REMOTE_TASKS_VIEW_TYPE = 'termesh-remote-tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Persistent read-only task snapshot view backed by an authenticated device connection. */
export class RemoteTasksView extends ItemView {
  private deviceId = '';
  private snapshotPath = '';
  private source: 'orchestrator' | 'mcp' = 'orchestrator';
  private busy = false;

  private readonly plugin: TerminalPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return REMOTE_TASKS_VIEW_TYPE; }
  getDisplayText(): string { return '研发任务进度'; }
  getIcon(): string { return 'workflow'; }

  onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('termesh-remote-tasks-view');
    this.contentEl.createEl('h2', { text: '研发任务进度' });
    this.contentEl.createEl('p', { text: '通过已配对设备连接读取任务状态镜像；任务执行及模型登录仍由控制端负责。' });
    const devices = this.plugin.getPairedDeviceStore().list();
    const connections = this.plugin.getDeviceConnectionManager();
    this.deviceId = devices.find(device => connections.isConnected(device.nodeId))?.nodeId ?? devices[0]?.nodeId ?? '';
    new Setting(this.contentEl).setName('被控设备').addDropdown(dropdown => {
      for (const device of devices) dropdown.addOption(device.nodeId, device.name);
      dropdown.setValue(this.deviceId).onChange(value => {
        this.deviceId = value;
        this.snapshotPath = this.plugin.settings.orchestratorStatusPaths?.[value] ?? '';
        pathInput.setValue(this.snapshotPath);
      });
    });
    new Setting(this.contentEl).setName('数据类型').addDropdown(dropdown => {
      dropdown.addOption('orchestrator', '研发编排任务（推荐）');
      dropdown.addOption('mcp', 'Lingxi 远程命令记录（兼容）');
      dropdown.setValue(this.source).onChange(value => { this.source = value === 'mcp' ? 'mcp' : 'orchestrator'; });
    });
    const pathInput = { setValue: (_value: string) => {} };
    new Setting(this.contentEl).setName('状态镜像文件').setDesc('填写被控设备上的任务镜像绝对路径；项目配置中的 runtime.taskmirror.remotepath 与此处一致。').addText(text => {
      pathInput.setValue = value => { text.setValue(value); };
      this.snapshotPath = this.plugin.settings.orchestratorStatusPaths?.[this.deviceId] ?? '';
      text.setValue(this.snapshotPath);
      text.setPlaceholder('C:\\work\\lingxi\\orchestrator-status\\tasks.json').onChange(value => { this.snapshotPath = value.trim(); });
      text.inputEl.addEventListener('blur', () => {
        this.plugin.settings.orchestratorStatusPaths ??= {};
        this.plugin.settings.orchestratorStatusPaths[this.deviceId] = this.snapshotPath;
        void this.plugin.saveSettings();
      });
    });
    const results = this.contentEl.createDiv();
    new Setting(this.contentEl).addButton(button => button.setButtonText('刷新任务').onClick(() => { void this.refresh(results); }));
    this.contentEl.createEl('p', { text: '此视图只读。服务断开或镜像时间过旧时，页面会保留时间戳供你判断，不会把旧状态当作实时成功。' });
    return Promise.resolve();
  }

  private async refresh(container: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    container.empty();
    try {
      if (!this.deviceId || !this.snapshotPath.toLowerCase().endsWith('.json')) throw new Error('请选择被控设备并填写 JSON 镜像路径。');
      const connections = this.plugin.getDeviceConnectionManager();
      await connections.connect(this.deviceId);
      const result = await connections.createTransferPuller(this.deviceId, this.snapshotPath).run();
      if (!result.success) throw new Error(result.message);
      if (result.files.length !== 1 || result.files[0].data.length > 512 * 1024) throw new Error('任务记录格式或大小不正确。');
      const raw: unknown = JSON.parse(new TextDecoder().decode(result.files[0].data));
      const isOrchestrator = isRecord(raw) && raw.source === 'lingxi-orchestrator';
      if (this.source === 'orchestrator' && !isOrchestrator) throw new Error('该文件不是 LingXi 编排器任务镜像。');
      if (this.source === 'mcp' && isOrchestrator) throw new Error('请选择“研发编排任务”数据类型以查看此镜像。');
      if (this.source === 'orchestrator' && isRecord(raw)) {
        this.renderOrchestratorSnapshot(container, raw);
        return;
      }
      if (!isRecord(raw) || !Array.isArray(raw.tasks)) throw new Error('任务记录格式不正确。');
      if ('updatedAt' in raw && typeof raw.updatedAt === 'string') container.createEl('p', { text: `记录时间：${raw.updatedAt}` });
      const tasks: unknown[] = raw.tasks;
      for (const task of tasks.slice(0, 30)) {
        if (!isRecord(task)) continue;
        const item = task;
        const value = (key: string): string => typeof item[key] === 'string' ? item[key] : '';
        const card = container.createEl('details');
        card.createEl('summary', { text: `${value('status')} · ${value('deviceId').slice(0, 12)} · ${value('action')} · ${value('target')}` });
        card.createEl('pre', { text: ['taskId', 'deviceId', 'sessionId', 'startedAt', 'updatedAt', 'stdout', 'stderr', 'error'].map(key => `${key}: ${value(key)}`).join('\n') });
      }
      if (!tasks.length) container.createEl('p', { text: '暂无任务记录。' });
    } catch (error) { container.createEl('p', { text: error instanceof Error ? error.message : String(error) }); }
    finally { this.busy = false; }
  }

  private renderOrchestratorSnapshot(container: HTMLElement, raw: Record<string, unknown>): void {
    const value = (item: unknown, key: string): unknown => item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
    const text = (item: unknown): string => typeof item === 'string' || typeof item === 'number' ? String(item) : '';
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    container.empty();
    container.createEl('p', { text: `仓库：${text(raw.repository)} · 镜像更新：${text(raw.updatedAt)}` });
    const nodeLabels: Record<string, string> = {
      'prepare-worktree': '准备开发工作区', develop: 'AI 开发', 'git-verify': '提交与工作区校验',
      'prepare-test-worktree': '准备测试工作区', test: '独立测试', 'local-verify': '本地质量检查',
      ci: 'GitHub CI', e2e: '端到端测试', 'rc-build': '候选版本构建', rc: '候选门禁',
    };
    const stateLabels: Record<string, string> = {
      PENDING: '等待中', RUNNING: '执行中', SUCCEEDED: '成功', FAILED: '失败', UNKNOWN: '结果待核对',
    };
    const taskStateLabels: Record<string, string> = {
      TEST_CASES_APPROVED: '待启动', IMPLEMENTING: '执行中', LOCAL_VERIFYING: '本地验证中',
      CI_VERIFYING: 'CI 验证中', FIXING: '修复中', RC_BUILDING: '候选版本构建中',
      RC_READY: '候选版本就绪', BLOCKED_USER_DECISION: '需要人工处理', RELEASE_APPROVED: '已批准发布',
      RELEASE_TRIGGERED: '已触发发布', RELEASED: '已发布', CANCELLED: '已取消',
    };
    for (const task of tasks) {
      const id = text(value(task, 'id'));
      const card = container.createEl('details');
      const summary = card.createEl('summary');
      const taskState = text(value(task, 'state'));
      summary.setText(`${id} · ${text(value(task, 'title'))} · ${taskStateLabels[taskState] ?? taskState}`);
      card.createEl('p', { text: `分支：${text(value(task, 'branch'))} · 更新：${text(value(task, 'updatedAt'))}` });
      const nodes = value(task, 'nodes');
      if (Array.isArray(nodes)) {
        const list = card.createEl('ul');
        for (const node of nodes) {
          const kind = text(value(node, 'kind'));
          const state = text(value(node, 'state'));
          const data = value(node, 'data');
          const detail = value(data, 'sha') || value(data, 'deliverySha') || value(data, 'exitCode');
          list.createEl('li', { text: `${nodeLabels[kind] ?? kind}：${stateLabels[state] ?? state}${detail === undefined ? '' : ` · ${text(detail)}`}` });
        }
      }
      if (text(value(task, 'currentNode'))) card.createEl('p', { text: `当前阶段：${nodeLabels[text(value(task, 'currentNode'))] ?? text(value(task, 'currentNode'))}` });
      const testReport = value(task, 'testReport');
      if (testReport && typeof testReport === 'object') {
        const reportUrl = text(value(testReport, 'url'));
        const report = card.createDiv();
        report.createEl('strong', { text: '测试报告' });
        const results = text(value(testReport, 'results'));
        if (results) report.createEl('p', { text: results });
        if (reportUrl.startsWith('https://github.com/')) report.createEl('a', { text: '打开交接报告', attr: { href: reportUrl, target: '_blank', rel: 'noopener noreferrer' } });
      }
      const workflows = value(task, 'workflows');
      if (Array.isArray(workflows) && workflows.length) {
        card.createEl('strong', { text: 'GitHub 工作流' });
        const list = card.createEl('ul');
        for (const workflow of workflows) {
          const item = list.createEl('li');
          const name = `${text(value(workflow, 'name'))} · ${text(value(workflow, 'conclusion') || value(workflow, 'status'))}`;
          const url = text(value(workflow, 'url'));
          if (url.startsWith('https://github.com/')) item.createEl('a', { text: name, attr: { href: url, target: '_blank', rel: 'noopener noreferrer' } });
          else item.setText(name);
        }
      }
      const artifacts = value(task, 'artifacts');
      if (Array.isArray(artifacts) && artifacts.length) card.createEl('p', { text: `构建制品：${artifacts.map(item => text(value(item, 'kind'))).filter(Boolean).join('、')}` });
      const events = value(task, 'events');
      if (Array.isArray(events) && events.length) {
        const history = card.createEl('details');
        history.createEl('summary', { text: '任务事件' });
        history.createEl('pre', { text: JSON.stringify(events, null, 2) });
      }
    }
    if (!tasks.length) container.createEl('p', { text: '暂无研发任务。' });
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }
}
