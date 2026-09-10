export interface ControlSequenceFilterState {
  pending: string;
}

export interface ControlSequenceFilterResult {
  text: string;
  removedControlSequence: boolean;
}

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

/**
 * Removes terminal-generated ANSI replies from xterm's onData stream.
 * xterm emits both real user input and replies to terminal queries through
 * onData, so history capture must not treat every emitted byte as a keypress.
 */
export function filterTerminalControlSequences(
  input: string,
  state: ControlSequenceFilterState,
): ControlSequenceFilterResult {
  const combined = `${state.pending}${input}`;
  state.pending = '';
  let output = '';
  let removedControlSequence = false;

  for (let index = 0; index < combined.length;) {
    if (combined[index] !== '\x1b') {
      output += combined[index];
      index += 1;
      continue;
    }

    const end = findControlSequenceEnd(combined, index);
    if (end === null) {
      state.pending = combined.slice(index);
      break;
    }
    removedControlSequence = true;
    index = end;
  }

  return { text: output, removedControlSequence };
}

function findControlSequenceEnd(value: string, start: number): number | null {
  if (start + 1 >= value.length) return null;
  const introducer = value[start + 1];
  if (introducer === '[') {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) return index + 1;
    }
    return null;
  }
  if (introducer === ']') return findStringSequenceEnd(value, start + 2, true);
  if (introducer === 'P' || introducer === '^' || introducer === '_') {
    return findStringSequenceEnd(value, start + 2, false);
  }
  return start + 2;
}

function findStringSequenceEnd(value: string, start: number, allowBell: boolean): number | null {
  for (let index = start; index < value.length; index += 1) {
    if (allowBell && value[index] === '\x07') return index + 1;
    if (value[index] === '\x1b') {
      if (index + 1 >= value.length) return null;
      if (value[index + 1] === '\\') return index + 2;
    }
  }
  return null;
}

/** Commands whose full-screen UI needs semantic key history capture. */
export function startsInteractiveCli(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:env\s+[^\s=]+=[^\s]+\s+)*(?:sudo\s+)?(?:\S*\/)?(?:codex|claude|opencode)(?:\s|$)/i.test(command.trim());
}
