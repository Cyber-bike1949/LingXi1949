/**
 * Logging utilities - only output logs in debug mode
 */

import * as nodeFs from 'fs';

let debugMode = false;
let shortcutReplayLogPath: string | null = null;

/**
 * Set debug mode
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
  console.warn('[ShortcutReplay] Debug mode initialized:', { enabled, debugMode });
}

/**
 * Get the current debug mode status
 */
export function isDebugMode(): boolean {
  return debugMode;
}

export function initializeShortcutReplayLog(filePath: string): void {
  shortcutReplayLogPath = filePath;
  try {
    nodeFs.writeFileSync(filePath, '', 'utf8');
  } catch (error) {
    shortcutReplayLogPath = null;
    console.warn('[ShortcutReplay] Failed to initialize log file:', error);
  }
}

export function shortcutReplayLog(...args: unknown[]): void {
  console.warn(...args, { debugMode });
  if (!shortcutReplayLogPath) return;
  const entry = {
    timestamp: new Date().toISOString(),
    message: args[0],
    details: args.slice(1),
    debugMode,
  };
  try {
    nodeFs.appendFileSync(shortcutReplayLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.warn('[ShortcutReplay] Failed to append log file:', error);
  }
}

/**
 * Debug logs - only output in debug mode
 */
export function debugLog(...args: unknown[]): void {
  if (debugMode) {
    console.debug(...args);
  }
}

/**
 * Debug warnings - only output in debug mode
 */
export function debugWarn(...args: unknown[]): void {
  if (debugMode) {
    console.warn(...args);
  }
}

/**
 * Error logs - always output (error messages are important)
 */
export function errorLog(...args: unknown[]): void {
  console.error(...args);
}
