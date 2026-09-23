import { Modal, Notice, Setting, type App } from 'obsidian';
import { t } from '../../i18n';
import { resolveBuiltinGroup } from '../../services/terminal/builtinShortcutGroups';
import type { ShortcutGroup } from '../../services/terminal/shortcutGroupStore';

export class BuiltinShortcutModal extends Modal {
  private settle: ((group: ShortcutGroup | null) => void) | null = null;
  static choose(app: App, group: ShortcutGroup, saveCopy: (group: ShortcutGroup) => Promise<void>): Promise<ShortcutGroup | null> {
    return new Promise(resolve => { const modal = new BuiltinShortcutModal(app, group, saveCopy); modal.settle = resolve; modal.open(); });
  }
  constructor(app: App, private group: ShortcutGroup, private saveCopy: (group: ShortcutGroup) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.group.name);
    this.contentEl.createEl('p', {text:t('release21.targetHint')});
    let platform: NodeJS.Platform | '' = this.group.deviceKey === 'local' ? process.platform : '';
    let shell = platform === 'win32' ? 'powershell' : 'bash';
    let resolved: ShortcutGroup | null = null;
    new Setting(this.contentEl).setName(t('release21.targetPlatform')).addDropdown(d => d.addOptions({'':'—',linux:'Linux',darwin:'macOS',win32:'Windows'}).setValue(platform).onChange(value => { platform = value as NodeJS.Platform; render(); }));
    new Setting(this.contentEl).setName(t('release21.targetShell')).addDropdown(d => d.addOptions({bash:'Bash',zsh:'Zsh',powershell:'PowerShell'}).setValue(shell).onChange(value => { shell = value; render(); }));
    const preview = this.contentEl.createEl('pre');
    const actions = this.contentEl.createDiv('modal-button-container');
    const copy = actions.createEl('button', {text:t('release21.copyGroup')});
    const run = actions.createEl('button', {text:t('common.confirm'),cls:'mod-cta'});
    const render = (): void => {
      try { if (!platform) throw new Error('PLATFORM_REQUIRED'); resolved = resolveBuiltinGroup(this.group,platform,shell); preview.setText(resolved.steps.map(s => s.payload).join('\n\n')); }
      catch { resolved = null; preview.setText(t('release21.unsupportedTarget')); }
      copy.disabled = !resolved; run.disabled = !resolved;
    };
    copy.addEventListener('click', () => { if (!resolved) return; const custom = {...resolved,id:`shortcut:${crypto.randomUUID()}`,name:`${resolved.name} (${t('release21.copy')})`,createdAt:Date.now(),creationOrder:Date.now(),steps:resolved.steps.map(s=>({...s,id:crypto.randomUUID()}))}; copy.disabled=true; void this.saveCopy(custom).then(()=>{new Notice(t('common.success'));this.close();}).catch((error:unknown)=>{new Notice(error instanceof Error?error.message:t('common.error'));copy.disabled=false;}); });
    run.addEventListener('click', () => { if (!resolved) return; this.settle?.(resolved);this.settle=null;this.close(); });
    render();
  }
  onClose(): void { this.settle?.(null);this.settle=null;this.contentEl.empty(); }
}
