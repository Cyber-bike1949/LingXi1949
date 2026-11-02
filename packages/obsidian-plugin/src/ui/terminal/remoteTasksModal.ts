import { Modal, Setting } from 'obsidian';
import type TerminalPlugin from '../../main';

/** Reads the model host's audit snapshot over its existing Agent connection. */
export class RemoteTasksModal extends Modal {
  private deviceId = '';
  private snapshotPath = '';
  private busy = false;

  constructor(private readonly plugin: TerminalPlugin) { super(plugin.app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText('远程模型任务');
    this.contentEl.createEl('p', { text: '选择运行模型和 lingxi-mcp 的模型中心，读取其任务记录。目标设备的选择与配对在模型中心的终端完成。' });
    const devices = this.plugin.getPairedDeviceStore().list();
    this.deviceId = devices[0]?.nodeId ?? '';
    new Setting(this.contentEl).setName('模型中心').addDropdown(dropdown => {
      for (const device of devices) dropdown.addOption(device.nodeId, device.name);
      dropdown.setValue(this.deviceId).onChange(value => { this.deviceId = value; });
    });
    new Setting(this.contentEl).setName('任务记录路径').setDesc('填写 B 上 lingxi-mcp 数据目录中的 tasks.json 绝对路径。').addText(text => {
      text.setPlaceholder('/home/example/.lingxi-mcp/tasks.json').onChange(value => { this.snapshotPath = value.trim(); });
    });
    const results = this.contentEl.createDiv();
    new Setting(this.contentEl).addButton(button => button.setButtonText('刷新任务').onClick(() => { void this.refresh(results); }));
    this.contentEl.createEl('p', { text: '此处显示最近保存的记录；连接中断后旧记录不能证明任务已完成。取消运行中的任务可在模型会话调用 remote_cancel，或结束该模型工具会话。' });
  }

  private async refresh(container: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    container.empty();
    try {
      if (!this.deviceId || !this.snapshotPath.endsWith('tasks.json')) throw new Error('请选择 B 设备并填写 tasks.json 路径。');
      const connections = this.plugin.getDeviceConnectionManager();
      await connections.connect(this.deviceId);
      const result = await connections.createTransferPuller(this.deviceId, this.snapshotPath).run();
      if (!result.success) throw new Error(result.message);
      if (result.files.length !== 1 || result.files[0].data.length > 512 * 1024) throw new Error('任务记录格式或大小不正确。');
      const raw: unknown = JSON.parse(new TextDecoder().decode(result.files[0].data));
      if (!raw || typeof raw !== 'object' || !('tasks' in raw) || !Array.isArray(raw.tasks)) throw new Error('任务记录格式不正确。');
      if ('updatedAt' in raw && typeof raw.updatedAt === 'string') container.createEl('p', { text: `记录时间：${raw.updatedAt}` });
      const tasks: unknown[] = raw.tasks;
      for (const task of tasks.slice(0, 30)) {
        if (!task || typeof task !== 'object') continue;
        const item = task as Record<string, unknown>;
        const value = (key: string): string => typeof item[key] === 'string' ? item[key] : '';
        const card = container.createEl('details');
        card.createEl('summary', { text: `${value('status')} · ${value('deviceId').slice(0, 12)} · ${value('action')} · ${value('target')}` });
        card.createEl('pre', { text: ['taskId', 'deviceId', 'sessionId', 'startedAt', 'updatedAt', 'stdout', 'stderr', 'error'].map(key => `${key}: ${value(key)}`).join('\n') });
      }
      if (!tasks.length) container.createEl('p', { text: '暂无任务记录。' });
    } catch (error) { container.createEl('p', { text: error instanceof Error ? error.message : String(error) }); }
    finally { this.busy = false; }
  }

  onClose(): void { this.contentEl.empty(); }
}
