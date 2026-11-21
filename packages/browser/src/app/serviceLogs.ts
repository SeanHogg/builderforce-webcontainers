/**
 * Every service's output as lines, tagged with the service. A reader gets the
 * history kept so far (a ring buffer), then lines live — one service's, or all
 * of them merged in arrival order. A service's log carries on across restarts.
 * Readers are bounded: one that falls behind loses the overflow, and is told.
 */
import { messageOf } from './asyncHelpers.js';
import { ringBuffer } from '../shared/ringBuffer.js';
import type { ServiceLogEntry } from './types.js';

export interface ServiceLogs {
  /**
   * Read a process's output into the log, line by line, until it ends.
   * Resolves once the last line (an unterminated one too) is in the log.
   */
  pipe(serviceId: string, output: ReadableStream<string>): Promise<void>;
  /** A line the runtime writes about a service (it failed, it restarts). */
  note(serviceId: string, text: string): void;
  /** History, then live lines; every service's when `serviceId` is omitted. Closed by `close()`. */
  stream(serviceId?: string): ReadableStream<ServiceLogEntry>;
  /** The last `limit` lines kept for `serviceId` (its output and the runtime's notes), oldest first. */
  recent(serviceId: string, limit: number): string[];
  /** End every reader's stream; later readers get the history, then end. */
  close(): void;
}

interface Reader {
  wanted(entry: ServiceLogEntry): boolean;
  controller: ReadableStreamDefaultController<ServiceLogEntry>;
  dropped: number;
}

/** Log lines kept for late readers, when `logHistory` is not set. */
const DEFAULT_LOG_HISTORY = 5000;

export function createServiceLogs(options: { history?: number; readerBuffer?: number } = {}): ServiceLogs {
  const history = ringBuffer<ServiceLogEntry>(Math.max(1, options.history ?? DEFAULT_LOG_HISTORY));
  const readerBuffer = Math.max(1, options.readerBuffer ?? 1000);
  const readers = new Set<Reader>();
  let closed = false;

  const deliver = (reader: Reader, entry: ServiceLogEntry) => {
    // Leave room for the "dropped" line, so a reader always learns it lost some.
    if ((reader.controller.desiredSize ?? 0) <= 1) {
      reader.dropped += 1;
      return;
    }
    if (reader.dropped > 0) {
      reader.controller.enqueue({ serviceId: entry.serviceId, source: 'runtime', text: `${reader.dropped} log lines dropped (reader fell behind).`, at: entry.at });
      reader.dropped = 0;
    }
    reader.controller.enqueue(entry);
  };

  const add = (entry: ServiceLogEntry) => {
    history.push(entry);
    for (const reader of readers) if (reader.wanted(entry)) deliver(reader, entry);
  };
  const line = (serviceId: string, source: ServiceLogEntry['source'], text: string) => add({ serviceId, source, text, at: Date.now() });

  return {
    pipe(serviceId, output) {
      return (async () => {
        let reader: ReadableStreamDefaultReader<string> | undefined;
        let partial = '';
        try {
          // Inside the try: a stream that cannot be read (already locked) is reported like one that errors.
          reader = output.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (partial + value).split(/\r?\n/);
            partial = lines.pop() ?? '';
            for (const text of lines) line(serviceId, 'output', text);
          }
        } catch (error) {
          line(serviceId, 'runtime', `Output stopped: ${messageOf(error)}`);
        } finally {
          if (partial) line(serviceId, 'output', partial);
          reader?.releaseLock();
        }
      })();
    },
    note: (serviceId, text) => line(serviceId, 'runtime', text),
    recent(serviceId, limit) {
      if (limit <= 0) return [];
      const lines: string[] = [];
      for (const entry of history) {
        if (entry.serviceId !== serviceId) continue;
        lines.push(entry.text);
        if (lines.length > limit) lines.shift();
      }
      return lines;
    },
    stream(serviceId) {
      let reader: Reader | undefined;
      return new ReadableStream<ServiceLogEntry>(
        {
          start(controller) {
            reader = { wanted: (entry) => serviceId === undefined || entry.serviceId === serviceId, controller, dropped: 0 };
            // History is bounded already: replay all of it; the reader bound applies to live lines.
            for (const entry of history) if (reader.wanted(entry)) controller.enqueue(entry);
            if (closed) controller.close();
            else readers.add(reader);
          },
          cancel() {
            if (reader) readers.delete(reader);
          },
        },
        new CountQueuingStrategy({ highWaterMark: readerBuffer }),
      );
    },
    close() {
      closed = true;
      for (const reader of readers) reader.controller.close();
      readers.clear();
    },
  };
}
