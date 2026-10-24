const text = description => ({ type: 'string', minLength: 1, description });
const schemas = {
  remote_read: { action: 'fs.read', fields: { path: text('Relative UTF-8 file path within the bound directory') } },
  remote_write: { action: 'fs.write', fields: { path: text('Relative file path; parent must exist'), content: { type: 'string', description: 'UTF-8 content, at most 128 KiB' } } },
  remote_delete: { action: 'fs.delete', fields: { path: text('Relative file or empty directory; deletion is not recursive') } },
  remote_list: { action: 'fs.list', fields: { path: text('Relative directory, use . for the bound root') } },
  remote_exec: { action: 'command.run', fields: { command: text('Command executed by the bound remote shell'), timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000, default: 120000 } }, optional: ['timeoutMs'] },
};
export const tools = [
  ...Object.entries(schemas).map(([name, spec]) => ({ name, description: `Run ${spec.action} on the fixed remote device. Never runs locally. Reuse requestId only for the same request.`, inputSchema: {
    type: 'object', properties: { requestId: text('Unique idempotency key for this operation'), ...spec.fields }, required: ['requestId', ...Object.keys(spec.fields).filter(k => !spec.optional?.includes(k))], additionalProperties: false,
  } })),
  { name: 'remote_target', description: 'Inspect the immutable device, directory and shell binding.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'remote_tasks', description: 'List recent tasks for this binding, or inspect one task.', inputSchema: { type: 'object', properties: { taskId: text('Task identifier') }, additionalProperties: false } },
  { name: 'remote_cancel', description: 'Request cancellation; inspect task status to confirm termination.', inputSchema: { type: 'object', properties: { taskId: text('Task identifier') }, required: ['taskId'], additionalProperties: false } },
];

function validate(name, args) {
  const schema = tools.find(t => t.name === name)?.inputSchema;
  if (!schema) throw new Error('UNKNOWN_TOOL');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
  for (const key of schema.required ?? []) if (!(key in args)) throw new Error(`MISSING_ARGUMENT: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) throw new Error(`UNEXPECTED_ARGUMENT: ${key}`);
    if (field.type === 'string' && (typeof value !== 'string' || (field.minLength && !value.length))) throw new Error(`INVALID_ARGUMENT: ${key}`);
    if (field.type === 'integer' && (!Number.isInteger(value) || value < field.minimum || value > field.maximum)) throw new Error(`INVALID_ARGUMENT: ${key}`);
  }
  if (args.requestId?.length > 200) throw new Error('REQUEST_ID_TOO_LONG');
  if (args.content && Buffer.byteLength(args.content) > 128 * 1024) throw new Error('FILE_TOO_LARGE');
  if (args.command?.length > 65536) throw new Error('COMMAND_TOO_LONG');
}

export async function callTool(service, name, args = {}, progress, signal) {
  validate(name, args);
  let result;
  if (name === 'remote_target') result = { ...service.binding, connected: service.adapter.connected };
  else if (name === 'remote_tasks') result = args.taskId ? service.store.get(service.scope, args.taskId) : service.store.list(service.scope);
  else if (name === 'remote_cancel') result = service.cancel(args.taskId);
  else result = await service.run({ action: schemas[name].action, ...args }, progress, signal);
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: ['FAILED','UNKNOWN','TIMED_OUT','OUTPUT_LIMIT'].includes(result?.status) };
}

export function serveStdio(service, input = process.stdin, output = process.stdout) {
  let initialized = false;
  let buffer = '';
  let closing = false;
  const pending = new Set();
  const cancellations = new Map();
  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const handle = async message => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    const { id, method, params = {} } = message;
    if (method === 'notifications/cancelled') { cancellations.get(params.requestId)?.abort(); return; }
    if (id === undefined) return;
    try {
      let result;
      if (method === 'initialize') {
        if (initialized) throw new Error('ALREADY_INITIALIZED');
        initialized = true;
        const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
        result = { protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'lingxi-mcp', version: '4.0.0' }, instructions: 'Use remote_target first. All remote tools are fixed to one user-selected device and directory. Native CLI shell/file tools still operate locally. Never substitute local execution for a failed remote operation.' };
      } else if (method === 'ping') result = {};
      else if (!initialized) throw new Error('NOT_INITIALIZED');
      else if (method === 'tools/list') result = { tools };
      else if (method === 'tools/call') {
        let count = 0;
        const cancellation = new AbortController();
        if (cancellations.has(id)) throw new Error('DUPLICATE_RPC_ID');
        cancellations.set(id, cancellation);
        try {
          result = await callTool(service, params.name, params.arguments, event => {
            const token = params._meta?.progressToken;
            if (typeof token === 'string' || typeof token === 'number') send({ method: 'notifications/progress', params: { progressToken: token, progress: ++count, message: JSON.stringify(event) } });
          }, cancellation.signal);
        } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
        finally { cancellations.delete(id); }
      } else {
        send({ id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send({ id, result });
    } catch (error) { send({ id, error: { code: -32602, message: error.message } }); }
  };
  input.setEncoding('utf8');
  input.on('data', chunk => {
    if (closing) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { closing = true; service.close(); input.destroy(new Error('MCP_INPUT_LIMIT')); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (pending.size >= 128) { send({ id: message.id ?? null, error: { code: -32000, message: 'Too many requests' } }); continue; }
      const task = handle(message); pending.add(task); void task.finally(() => pending.delete(task));
    }
  });
  return new Promise(resolve => {
    const stop = async () => { if (!closing) { closing = true; service.close(); } await Promise.allSettled(pending); resolve(); };
    input.once('end', () => { void stop(); });
    input.once('error', () => { void stop(); });
  });
}
