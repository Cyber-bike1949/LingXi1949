export interface AiCliFileBinding {
  session: string;
  deviceId: string;
  workDir: string;
  /** Session connection address; does not modify the plugin's paired devices. */
  ticket?: string;
}

const OSC_PREFIX = 'LingXi1949;ai-binding;';
const OSC_END = 'LingXi1949;ai-binding-end';
const MAX_BINDING_PAYLOAD = 16384;

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
    if (value.ticket !== undefined && (
      typeof value.ticket !== 'string' || !value.ticket.trim() || value.ticket.length > 8192
      || /\s/.test(value.ticket)
    )) return undefined;
    return {
      session: value.session, deviceId: value.deviceId, workDir: value.workDir,
      ...(value.ticket === undefined ? {} : { ticket: value.ticket }),
    };
  } catch {
    return undefined;
  }
}
