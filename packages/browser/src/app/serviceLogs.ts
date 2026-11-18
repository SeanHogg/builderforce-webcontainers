/**
 * Every service's output as lines, tagged with the service. A reader gets the
 * history kept so far, then lines live — one service's, or all of them merged in
 * arrival order. A service's log carries on across its restarts.
 */
import { createListeners } from './listeners.js';
import type { ServiceLogEntry } from './types.js';

export interface ServiceLogs {
  /** Read a process's output into the log, line by line, until it ends. */
  pipe(serviceId: string, output: ReadableStream<string>): void;
  /** A line the runtime writes about a service (it failed, it restarts). */
  note(serviceId: string, text: string): void;
  /** History, then live lines; every service's when `serviceId` is omitted. */
  stream(serviceId?: string): ReadableStream<ServiceLogEntry>;
}

export function createServiceLogs(historyLimit = 5000): ServiceLogs {
  const history: ServiceLogEntry[] = [];
  const live = createListeners<ServiceLogEntry>();

  const add = (entry: ServiceLogEntry) => {
    history.push(entry);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    live.emit(entry);
  };
  const line = (serviceId: string, source: ServiceLogEntry['source'], text: string) => add({ serviceId, source, text, at: Date.now() });

  return {
    pipe(serviceId, output) {
      void (async () => {
        const reader = output.getReader();
        let partial = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (partial + value).split(/\r?\n/);
            partial = lines.pop() ?? '';
            for (const text of lines) line(serviceId, 'output', text);
          }
        } catch (error) {
          line(serviceId, 'runtime', `Output stopped: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (partial) line(serviceId, 'output', partial);
          reader.releaseLock();
        }
      })();
    },
    note: (serviceId, text) => line(serviceId, 'runtime', text),
    stream(serviceId) {
      const wanted = (entry: ServiceLogEntry) => serviceId === undefined || entry.serviceId === serviceId;
      let unsubscribe: (() => void) | undefined;
      return new ReadableStream<ServiceLogEntry>({
        start(controller) {
          for (const entry of history) if (wanted(entry)) controller.enqueue(entry);
          unsubscribe = live.on((entry) => wanted(entry) && controller.enqueue(entry));
        },
        cancel() {
          unsubscribe?.();
        },
      });
    },
  };
}
