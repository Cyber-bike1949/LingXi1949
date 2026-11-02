import { posix, win32 } from 'node:path';
export interface FileOperationRequest {
  action: 'capabilities' | 'inspect' | 'delete' | 'move' | 'status';
  root: string;
  path?: string;
  target?: string;
  expectedIdentity?: string;
  operationId?: string;
}
export interface FileOperationResponse {
  status: 'success' | 'failed' | 'partial' | 'unknown';
  code?: string;
  identity?: string;
  entryType?: string;
  newPath?: string;
  mutationVersion: number;
}
export function relativeOperationPath(root: string, path: string): string {
  const api = /^[a-z]:|^\\\\/i.test(root) ? win32 : posix;
  const relative = api.relative(root, path);
  if (api.isAbsolute(relative) || relative.split(api.sep).includes('..')) throw new Error('OUTSIDE_ROOT');
  return relative.split(api.sep).join('/');
}
export function parseFileOperationResponse(value: unknown): FileOperationResponse {
  if (!value || typeof value !== 'object') throw new Error('INVALID_FILE_RESULT');
  const raw = value as Record<string, unknown>;
  if (!['success', 'failed', 'partial', 'unknown'].includes(String(raw.status)) || raw.mutationVersion !== 1) throw new Error('INVALID_FILE_RESULT');
  for (const key of ['code', 'identity', 'entryType', 'newPath']) if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error('INVALID_FILE_RESULT');
  return raw as unknown as FileOperationResponse;
}
