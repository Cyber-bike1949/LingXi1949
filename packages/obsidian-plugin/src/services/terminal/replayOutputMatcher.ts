export function normalizeReplayOutput(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences intentionally contain control characters.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex, no-useless-escape -- ANSI escape sequences intentionally contain control characters.
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- Terminal output filtering intentionally removes control characters.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function outputAfterShellEcho(value: string, command: string): string {
  const normalizedCommand = normalizeReplayOutput(command);
  if (!normalizedCommand) return value;
  const visible = value
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences intentionally contain control characters.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex, no-useless-escape -- ANSI escape sequences intentionally contain control characters.
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
  const lines = visible.split(/\r?\n/);
  const echoIndex = lines.findIndex((line) => normalizeReplayOutput(line).endsWith(normalizedCommand));
  return echoIndex < 0 ? '' : lines.slice(echoIndex + 1).join('\n');
}