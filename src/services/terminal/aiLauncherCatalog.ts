/**
 * AI launcher catalog
 *
 * Classifies the built-in workflow launchers into product categories so the
 * status bar menu can group them and surface readiness state. The catalog
 * is purely metadata — actual execution still goes through {@link runPresetScript}.
 *
 * Termy currently only ships "coding agent" launchers (Claude Code, Codex,
 * OpenCode). The category type is left as a discriminated union with one
 * arm so it stays explicit at every render site — adding a new product
 * category in the future means widening this type and revisiting every
 * call site, which is exactly the friction we want.
 */

export type AiLauncherCategory = 'coding-agent';

/**
 * Visual readiness state used by the launcher menu.
 *  - 'ready'            → the underlying CLI was found on PATH (or the entry is
 *                         always-available such as a future bundled binary).
 *  - 'not-installed'    → the CLI is missing; the menu shows install guidance.
 *  - 'update-available' → the CLI works locally but the upstream registry
 *                         reports a newer version. Only set when the user
 *                         opted in to update checks.
 *  - 'checking'         → readiness probe is still in flight; transient.
 */
export type AiLauncherStatus = 'ready' | 'not-installed' | 'update-available' | 'checking';

/**
 * Result of partitioning a list of preset scripts by their AI launcher
 * catalog category. Scripts whose id is not in the catalog land in
 * {@link PartitionedLaunchers.regular}.
 */
export interface PartitionedLaunchers<TScript extends { id: string }> {
  codingAgent: TScript[];
  regular: TScript[];
}

/**
 * Where Termy looks up the CLI's latest version. The lookup itself is opt-in
 * and only runs when the user enables `checkAiLauncherUpdates` in settings,
 * because the request goes outbound to npm/GitHub — the README and
 * `AGENTS.md` document this explicitly so the contractual "no extra
 * outbound traffic" promise is preserved by default.
 */
export type LatestVersionRegistry =
  | { kind: 'npm'; package: string }
  | { kind: 'github-release'; repo: string };

/**
 * Catalog entry for a preset script that should be classified as an AI launcher.
 */
export interface AiLauncherCatalogEntry {
  /** Matches the {@link PresetScript.id} so we can reuse the existing workflow runner. */
  presetId: string;
  /** Category bucket used by the status bar menu. */
  category: AiLauncherCategory;
  /** CLI executable to probe with `where` / `which`. */
  detectCommand?: string;
  /** Optional documentation URL surfaced in the install modal. */
  installDocsUrl?: string;
  /**
   * One-liner install commands, surfaced in the install modal and also
   * typed into the terminal automatically (both local and remote) when the
   * CLI is found missing — see `ensureAiLauncherInstalledInTerminal` and
   * `launchAgentOnDevice` in main.ts. This is a deliberate 2026-09-03
   * decision (candidate doc "Agent 启动流程简化" §6.2/§6.4, design doc §5)
   * to auto-run installs rather than only display guidance, which is a
   * known departure from this project's earlier stated Obsidian-marketplace
   * "no plugin-driven native-dependency installs" stance; see §5 of the
   * design doc for the full record if this needs revisiting for a
   * marketplace submission.
   *
   * Each value is the most ergonomic command for that platform as
   * documented by the upstream project. Leave a platform out if no
   * single command works — the modal then falls back to a docs link, and
   * the auto-install flow shows an "unavailable" notice and stops.
   */
  installCommands?: Partial<Record<NodeJS.Platform, string>>;
  /**
   * One-liner upgrade commands shown when an update is available. The user
   * clicks "Update now" in the install modal and Termy types the command
   * into a fresh terminal, same automation posture as {@link installCommands}
   * above.
   *
   * Leave a platform out if no single command can upgrade the launcher
   * on that platform; the modal then falls back to the install-command
   * card and a docs link.
   */
  upgradeCommands?: Partial<Record<NodeJS.Platform, string>>;
  /**
   * Where to ask for the latest published version of this CLI. Optional
   * because some launchers may ship without a public registry entry.
   */
  versionRegistry?: LatestVersionRegistry;
}

/**
 * Static catalog. Adding a new built-in launcher means appending an entry here.
 *
 * Termy currently only ships first-party coding agent launchers. When a new
 * product category is introduced, add a new arm to {@link AiLauncherCategory}
 * and update every render site (TypeScript will fail the build until you do).
 */
export const AI_LAUNCHER_CATALOG: readonly AiLauncherCatalogEntry[] = [
  {
    presetId: 'claude-code',
    category: 'coding-agent',
    detectCommand: 'claude',
    installDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/quickstart',
    installCommands: {
      // Anthropic ships a native installer; no Node.js required.
      // See https://code.claude.com/docs/en/quickstart#step-1-install-claude-code
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
      // Default to PowerShell on Windows; the docs URL covers the CMD variant.
      win32: 'irm https://claude.ai/install.ps1 | iex',
    },
    versionRegistry: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    // `claude update` (alias `upgrade`) is the upstream-recommended way
    // to bump the native installer, regardless of how the user installed
    // the binary originally. Same command on every platform.
    upgradeCommands: {
      darwin: 'claude update',
      linux: 'claude update',
      win32: 'claude update',
    },
  },
  {
    presetId: 'codex',
    category: 'coding-agent',
    detectCommand: 'codex',
    installDocsUrl: 'https://github.com/openai/codex',
    installCommands: {
      // OpenAI's two recommended paths from the README; brew avoids
      // pulling in Node when the user has Homebrew.
      darwin: 'brew install --cask codex',
      linux: 'npm install -g @openai/codex',
      win32: 'npm install -g @openai/codex',
    },
    versionRegistry: { kind: 'npm', package: '@openai/codex' },
    // OpenAI does not ship a `codex update` subcommand yet, so we reuse
    // the install paths with `@latest` for npm and brew's upgrade verb.
    upgradeCommands: {
      darwin: 'brew upgrade --cask codex',
      linux: 'npm install -g @openai/codex@latest',
      win32: 'npm install -g @openai/codex@latest',
    },
  },
  {
    presetId: 'opencode',
    category: 'coding-agent',
    detectCommand: 'opencode',
    installDocsUrl: 'https://opencode.ai/docs',
    installCommands: {
      // OpenCode publishes a single-binary install script for Unix shells.
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      linux: 'curl -fsSL https://opencode.ai/install | bash',
      // npm works universally on Windows without requiring scoop.
      win32: 'npm install -g opencode-ai',
    },
    versionRegistry: { kind: 'github-release', repo: 'anomalyco/opencode' },
    // OpenCode's install script performs in-place upgrades on Unix.
    // On Windows, npm handles the upgrade via @latest.
    upgradeCommands: {
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      linux: 'curl -fsSL https://opencode.ai/install | bash',
      win32: 'npm install -g opencode-ai@latest',
    },
  },
];

const CATALOG_INDEX = new Map<string, AiLauncherCatalogEntry>(
  AI_LAUNCHER_CATALOG.map((entry) => [entry.presetId, entry])
);

export function getAiLauncherEntry(presetId: string): AiLauncherCatalogEntry | undefined {
  return CATALOG_INDEX.get(presetId);
}

/**
 * Pick the install command the launcher modal should display, based on the
 * current platform. Returns null when no upstream command is documented for
 * the platform — the modal then falls back to its docs link.
 */
export function getInstallCommandForPlatform(
  entry: AiLauncherCatalogEntry,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const commands = entry.installCommands;
  if (!commands) return null;
  const exact = commands[platform];
  if (typeof exact === 'string' && exact.length > 0) return exact;
  return null;
}

/**
 * Pick the upgrade command the launcher modal should run when the user
 * clicks "Update now". Returns null when no upgrade command is documented
 * for the platform — the modal then falls back to the install command +
 * docs link instead of offering a one-click upgrade.
 */
export function getUpgradeCommandForPlatform(
  entry: AiLauncherCatalogEntry,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const commands = entry.upgradeCommands;
  if (!commands) return null;
  const exact = commands[platform];
  if (typeof exact === 'string' && exact.length > 0) return exact;
  return null;
}

/** The `provider`/`model`/`apiKey` fields a `DeviceAgentConfig` carries (see settings.ts). */
export interface AgentLaunchConfig {
  provider: string;
  model: string;
  apiKey: string | null;
}

// claude-code and codex each have one well-documented API-key env var and a
// `--model` flag; opencode's key wiring is provider-specific (its own config
// file, not a single env var), so only `--model` is applied there.
const LAUNCH_MODEL_FLAG: Partial<Record<string, string>> = {
  'claude-code': '--model',
  codex: '--model',
  opencode: '--model',
};
const LAUNCH_API_KEY_ENV_VAR: Partial<Record<string, string>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};
// Only applied when `provider` looks like a URL - both CLIs document this
// env var for pointing at an Anthropic/OpenAI-API-compatible endpoint other
// than the default one, which is the one unambiguous way to use a free-form
// "provider" string without guessing a name → URL mapping for every
// possible third-party provider.
const LAUNCH_BASE_URL_ENV_VAR: Partial<Record<string, string>> = {
  'claude-code': 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
};

function toEnvVarName(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turns a device's stored `DeviceAgentConfig` (candidate doc "Agent 启动
 * 流程简化" §6.2/§6.5 Q9: generic provider/model/apiKey fields, not full
 * per-Provider coverage) into the actual command line Termy types into the
 * terminal for one launch (§2.3.5 G11). Anything outside
 * {@link LAUNCH_API_KEY_ENV_VAR} (Q6's "reserve extensibility for other
 * agents") falls back to an upper-snake-cased `<AGENT_ID>_API_KEY` env var -
 * a guess, but a harmless one, since an unrecognized env var is simply
 * ignored by whatever CLI the user pointed this at.
 */
export function buildAgentLaunchCommand(
  agentId: string,
  baseCommand: string,
  config: AgentLaunchConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  let command = baseCommand;

  const modelFlag = LAUNCH_MODEL_FLAG[agentId] ?? '--model';
  if (config.model.trim()) {
    command = `${command} ${modelFlag} ${quoteShellArg(config.model.trim(), platform)}`;
  }

  const envAssignments: Array<[string, string]> = [];
  if (config.apiKey) {
    envAssignments.push([LAUNCH_API_KEY_ENV_VAR[agentId] ?? `${toEnvVarName(agentId)}_API_KEY`, config.apiKey]);
  }
  const provider = config.provider.trim();
  const baseUrlEnvVar = LAUNCH_BASE_URL_ENV_VAR[agentId];
  if (provider && baseUrlEnvVar && /^https?:\/\//i.test(provider)) {
    envAssignments.push([baseUrlEnvVar, provider]);
  }

  if (envAssignments.length === 0) return command;

  // cmd.exe has no clean one-shot inline env syntax, so `set` is used
  // instead - this persists for the rest of the session rather than
  // scoping to just this command, unlike the POSIX `VAR=value cmd` form.
  if (platform === 'win32') {
    const setPrefix = envAssignments
      .map(([name, value]) => `set "${name}=${value.replace(/"/g, '""')}"`)
      .join(' && ');
    return `${setPrefix} && ${command}`;
  }

  const inlineEnv = envAssignments.map(([name, value]) => `${name}=${quoteShellArg(value, platform)}`).join(' ');
  return `${inlineEnv} ${command}`;
}

/**
 * Partition a list of preset scripts (or any object exposing an `id`) into
 * the catalog buckets used by the status bar menu and the settings page.
 * Scripts not present in the catalog land in {@link PartitionedLaunchers.regular}.
 *
 * Pure function — kept side-effect free so it can be unit tested in isolation
 * without spawning command detectors.
 */
export function partitionLaunchers<TScript extends { id: string }>(
  scripts: readonly TScript[],
): PartitionedLaunchers<TScript> {
  const codingAgent: TScript[] = [];
  const regular: TScript[] = [];

  for (const script of scripts) {
    const entry = CATALOG_INDEX.get(script.id);
    if (!entry) {
      regular.push(script);
      continue;
    }
    if (entry.category === 'coding-agent') {
      codingAgent.push(script);
    }
  }

  return { codingAgent, regular };
}

/**
 * Map a {@link CommandAvailability}-style result onto the badge status.
 * Centralised so menu and settings page apply the same rule.
 */
export function commandAvailabilityToLauncherStatus(
  availability: 'ready' | 'not-installed' | 'unknown',
): AiLauncherStatus {
  if (availability === 'ready') return 'ready';
  if (availability === 'not-installed') return 'not-installed';
  return 'ready';
}
