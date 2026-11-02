import { AI_LAUNCHER_CATALOG, getInstallCommandForPlatform } from './aiLauncherCatalog.ts';
import type { ShortcutGroup } from './shortcutGroupStore.ts';

const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
export function availableShortcutGroups(custom: ShortcutGroup[], deviceKey: string, installLabel: string): ShortcutGroup[] {
  const builtins = AI_LAUNCHER_CATALOG.map((tool): ShortcutGroup => ({
    id: `builtin:install:${tool.presetId}`, deviceKey, name: `${installLabel} ${names[tool.presetId] ?? tool.presetId}`,
    createdAt: 0, creationOrder: 0, schemaVersion: 1, steps: [],
  }));
  return [...custom.filter(g => g.deviceKey === deviceKey).sort((a,b) => b.creationOrder-a.creationOrder), ...builtins];
}
export function resolveBuiltinGroup(group: ShortcutGroup, platform: NodeJS.Platform, shell: string): ShortcutGroup {
  const tool = AI_LAUNCHER_CATALOG.find(entry => group.id === `builtin:install:${entry.presetId}`);
  if (!tool) throw new Error('UNKNOWN_BUILTIN');
  if (platform === 'win32' ? shell !== 'powershell' : !['bash', 'zsh'].includes(shell)) throw new Error('UNSUPPORTED_SHELL');
  const install = getInstallCommandForPlatform(tool, platform);
  if (!install) throw new Error('UNSUPPORTED_PLATFORM');
  const prerequisite = install.startsWith('npm ') ? 'npm' : install.startsWith('brew ') ? 'brew' : platform === 'win32' ? null : 'curl';
  const payloads = [
    ...(prerequisite ? [platform === 'win32' ? `Get-Command ${prerequisite} -ErrorAction Stop` : `command -v ${prerequisite}`] : []),
    install,
  ];
  return { ...group, steps: payloads.map((payload, i) => ({ id: `${group.id}:${i}`, kind: 'shell', summary: payload, payload, captureQuality: 'complete', completion: 'resolved', sequence: i + 1 })) };
}
