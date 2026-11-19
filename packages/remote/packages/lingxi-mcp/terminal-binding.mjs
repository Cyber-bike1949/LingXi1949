const PREFIX = '\u001b]1949;LingXi1949;ai-binding;';
const END = '\u001b]1949;LingXi1949;ai-binding-end\u0007';

export function aiBindingStartSequence(binding) {
  const payload = Buffer.from(JSON.stringify({
    session: binding.session,
    deviceId: binding.deviceId,
    workDir: binding.workDir,
  })).toString('base64url');
  return `${PREFIX}${payload}\u0007`;
}

export function aiBindingEndSequence() {
  return END;
}

export function announceAiBinding(stream, binding) {
  if (!stream?.isTTY) return false;
  stream.write(aiBindingStartSequence(binding));
  return true;
}

export function clearAiBinding(stream) {
  if (!stream?.isTTY) return;
  stream.write(aiBindingEndSequence());
}
