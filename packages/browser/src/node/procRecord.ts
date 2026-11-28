/** The page-side record of one running process (processHost.ts): everything the page holds for its Worker. */
import type { StdioChunk, createIpcEndpoint } from '@seanhogg/builderforce-webcontainers-core';
import type { ChildRelay } from './childRelay.js';
import type { ConnectionRelay } from './connectionRelay.js';
import type { ProcessInfo, WorkerLike } from './processHost.js';
import type { WorkerKind } from './protocol.js';
import type { ResponseReceiver } from './responseWire.js';

export interface Proc {
  readonly ancestors: readonly number[];
  pid: number;
  /** The Worker kind running it: what it may send is judged by this, never by its own claims. */
  kind: WorkerKind;
  info: Omit<ProcessInfo, 'ports'>;
  worker: WorkerLike;
  stdout: Set<(chunk: StdioChunk) => void>;
  stderr: Set<(chunk: StdioChunk) => void>;
  exited: boolean;
  resolveExit(code: number): void;
  registrations: Map<number, { close(): void }>;
  /** The children its Worker spawned, relayed back to it. */
  children: ChildRelay;
  /** Its message channel to whoever spawned it with `ipc`: the parent's side. */
  ipc?: ReturnType<typeof createIpcEndpoint>;
  /** Responses its servers are streaming back to requests forwarded here. */
  responses: ResponseReceiver;
  /** Its loopback requests being answered, by the worker's request id: cancel functions. */
  loopbacks: Map<number, () => void>;
  /** Connections to its servers (upgraded or raw TCP) and the ones it dialled. */
  connections: ConnectionRelay;
}

export const EXITED = 'The server process exited.';
