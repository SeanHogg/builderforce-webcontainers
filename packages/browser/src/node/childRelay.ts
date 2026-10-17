/**
 * The page side of the children ONE process Worker spawns (a shell running
 * `node`, `child_process.fork`, a `worker_threads` Worker): each is started as a
 * process of its own, and its output, exit and message channel are relayed back
 * to the spawning Worker, keyed by the Worker's own child id.
 */
import type { ChildHandle, ProcessOptions } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';

type ChildMessage = Extract<WorkerToHost, { type: 'spawn' | 'child-stdin' | 'child-kill' | 'child-resize' | 'child-ipc' | 'child-ipc-disconnect' }>;

const CHILD_MESSAGES = new Set<string>(['spawn', 'child-stdin', 'child-kill', 'child-resize', 'child-ipc', 'child-ipc-disconnect']);

export function isChildMessage(message: WorkerToHost): message is ChildMessage {
  return CHILD_MESSAGES.has(message.type);
}

export class ChildRelay {
  private readonly children = new Map<number, ChildHandle>();

  constructor(
    private readonly spawn: (command: string, args: string[], options: ProcessOptions) => ChildHandle,
    private readonly post: (message: HostToWorker) => void,
  ) {}

  receive(message: ChildMessage): void {
    if (message.type === 'spawn') return this.start(message);
    const child = this.children.get(message.childId);
    switch (message.type) {
      case 'child-stdin':
        if (message.data === null) child?.closeStdin();
        else child?.write(message.data);
        return;
      case 'child-kill':
        return child?.kill(message.signal);
      case 'child-resize':
        return child?.resize?.(message.cols, message.rows);
      case 'child-ipc':
        return child?.ipc?.send(message.data);
      case 'child-ipc-disconnect':
        return child?.ipc?.disconnect();
    }
  }

  private start(message: Extract<ChildMessage, { type: 'spawn' }>): void {
    const { childId } = message;
    let child: ChildHandle;
    try {
      child = this.spawn(message.command, message.args, { cwd: message.cwd, env: message.env, terminal: message.terminal, ipc: message.ipc, thread: message.thread });
    } catch (error) {
      return this.post({ type: 'child-error', childId, code: (error as { code?: string }).code ?? 'EFAIL', message: (error as Error).message });
    }
    this.children.set(childId, child);
    child.onStdout((data) => this.post({ type: 'child-out', childId, stream: 'stdout', data }));
    child.onStderr((data) => this.post({ type: 'child-out', childId, stream: 'stderr', data }));
    child.ipc?.onMessage((data) => this.post({ type: 'child-ipc', childId, data }));
    child.ipc?.onDisconnect(() => this.post({ type: 'child-ipc-disconnect', childId }));
    void child.exit.then((code) => {
      this.children.delete(childId);
      this.post({ type: 'child-exit', childId, code });
    });
  }
}
