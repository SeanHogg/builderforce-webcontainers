/**
 * The worker side of a process's servers, as every process Worker kind sees
 * them (Node's workerProcess.ts, Python's pythonWorkerProcess.ts): which ports
 * are taken anywhere in the runtime (so `listen` fails fast with EADDRINUSE),
 * answering the page's `http-request`s from the handler on that port with a
 * streamed response (responseWire.ts) and hanging up on `request-cancel`, and
 * hearing how the page answered a `listen` (`listened`, `listen-failed`).
 */
import type { HttpHandler } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { sendResponse } from './responseWire.js';
import { textResponse } from '@seanhogg/builderforce-webcontainers-core';

export interface ServedPortsOptions {
  post(message: WorkerToHost): void;
  /** The handler serving `port` in this process, if any. */
  handlerFor(port: number): HttpHandler | undefined;
  /** The page refused this process's `listen` on `port` (`message` says why; `id` is the listen's). */
  onListenFailed(port: number, message: string, id: number | undefined): void;
  /** The page registered this process's `listen` on `port`. */
  onListened?(port: number, id: number | undefined): void;
}

export interface ServedPorts {
  /** Ports taken anywhere in the runtime, this process's own included. */
  readonly taken: Set<number>;
  /** Handle `ports`, `http-request`, `request-cancel`, `listened` and `listen-failed`; false for any other message. */
  receive(message: HostToWorker): boolean;
  /** Hang up every response still streaming. */
  cancelAll(): void;
}

/** The answer for a port nothing in this process serves. */
export const notListening = (port: number) => textResponse(502, `Nothing is listening on port ${port}.`);

export function createServedPorts(options: ServedPortsOptions): ServedPorts {
  const taken = new Set<number>();
  /** Responses this process's servers are streaming to the page, by the page's request id. */
  const serving = new Map<number, () => void>();
  return {
    taken,
    receive(message) {
      switch (message.type) {
        case 'ports':
          for (const port of message.open) taken.add(port);
          // A port this process still serves stays taken whatever the page says.
          for (const port of message.closed) if (!options.handlerFor(port)) taken.delete(port);
          return true;
        case 'http-request': {
          const { reqId } = message;
          const handler = options.handlerFor(message.port);
          const response = handler ? handler(message.request) : Promise.resolve(notListening(message.port));
          serving.set(reqId, sendResponse(options.post, reqId, response, () => serving.delete(reqId)));
          return true;
        }
        case 'request-cancel':
          serving.get(message.reqId)?.();
          return true;
        case 'listen-failed':
          options.onListenFailed(message.port, message.message, message.id);
          return true;
        case 'listened':
          options.onListened?.(message.port, message.id);
          return true;
        default:
          return false;
      }
    },
    cancelAll() {
      for (const cancel of [...serving.values()]) cancel();
      serving.clear();
    },
  };
}
