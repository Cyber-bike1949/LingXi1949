export interface AiCliFileBinding {
  session: string;
  deviceId: string;
  workDir: string;
}

const OSC_PREFIX = 'LingXi1949;ai-binding;';
const OSC_END = 'LingXi1949;ai-binding-end';
const MAX_BINDING_PAYLOAD = 4096;

export function decodeAiCliBindingOsc(data: string): AiCliFileBinding | null | undefined {
  if (data === OSC_END) return null;
  if (!data.startsWith(OSC_PREFIX)) return undefined;

  const encoded = data.slice(OSC_PREFIX.length);
  if (!encoded || encoded.length > MAX_BINDING_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<AiCliFileBinding>;
    if (
      typeof value.session !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.session)
      || typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.deviceId)
      || typeof value.workDir !== 'string' || !value.workDir.trim() || value.workDir.length > 2048
      || [...value.workDir].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    ) return undefined;
    return { session: value.session, deviceId: value.deviceId, workDir: value.workDir };
  } catch {
    return undefined;
  }
}
