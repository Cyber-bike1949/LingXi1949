import { StringDecoder } from 'node:string_decoder';

export class TaskService {
  constructor(adapter, store, binding, scope) {
    this.adapter = adapter; this.store = store; this.binding = Object.freeze({ ...binding }); this.scope = scope;
    this.active = new Map();
    store.recover(scope);
    store.bind(scope, binding);
  }
  async run(input, onProgress = () => {}, signal) {
    const { task, fresh } = this.store.begin(this.scope, this.binding, input);
    if (!fresh) return task;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.active.set(task.task_id, abort);
    this.store.running(task.task_id);
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    try {
      const result = await this.adapter.request({ ...input, sessionId: this.binding.sessionId, bindingVersion: this.binding.bindingVersion }, {
        signal: abort.signal,
        onOutput: (channel, bytes) => {
          const text = decoders[channel].write(bytes);
          this.store.output(task.task_id, channel, text);
          onProgress({ taskId: task.task_id, deviceId: this.binding.deviceId, channel, text });
        },
      });
      this.store.finish(task.task_id, result.status, result);
    } catch (e) {
      this.store.finish(task.task_id, 'UNKNOWN', { error: String(e.message ?? e) });
    } finally {
      for (const channel of ['stdout', 'stderr']) this.store.output(task.task_id, channel, decoders[channel].end());
      this.active.delete(task.task_id);
      signal?.removeEventListener('abort', cancel);
    }
    return this.store.get(this.scope, task.task_id);
  }
  cancel(id) {
    const task = this.store.get(this.scope, id);
    if (!task) throw new Error('UNKNOWN_TASK');
    const active = this.active.get(id);
    if (active) active.abort();
    return { ...task, cancellationRequested: !!active };
  }
  close() { this.adapter.close(); }
}
