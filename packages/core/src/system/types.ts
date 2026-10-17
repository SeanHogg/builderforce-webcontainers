/**
 * The contract between programs (node, the shell, npm, coreutils) and whatever
 * hosts them. Programs only ever see these ports, so the same program code runs
 * in-process under the core `Kernel` (Node tests) and one-per-Web-Worker in the
 * browser runtime, where `spawn` and `listen` are relayed to the page.
 */
import type { VirtualFileSystem } from '../vfs.js';
import type { PackageCache } from '../installer/registry.js';
import type { IpcEndpoint } from './ipc.js';

export interface TerminalPort {
  cols: number;
  rows: number;
  onResize(listener: (cols: number, rows: number) => void): () => void;
  /** Raw mode: the program handles keystrokes itself (no line editing, no echo). */
  setRawMode(raw: boolean): void;
}

export interface ProgramIO {
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
  /** Stdin chunks as they arrive; `null` is end-of-file. Buffered until the first subscriber. */
  onStdin(listener: (chunk: string | null) => void): () => void;
  /** Present when attached to a terminal (xterm.js). */
  terminal?: TerminalPort;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Attach to a terminal of this size (`isTTY`, line discipline, `\r\n` output). */
  terminal?: { cols: number; rows: number };
  /** Open a message channel to the child (`child_process.fork`); the handle's `ipc` is the parent's end. */
  ipc?: boolean;
  /** Run as a `worker_threads` Worker: the child's `worker_threads` reports this, over the `ipc` channel. */
  thread?: ThreadInfo;
  /** Outlive the parent (`spawn(…, { detached: true })`). Otherwise a child still running when its parent exits is killed with it. */
  detached?: boolean;
}

/** What a process started as a worker thread sees in `worker_threads`. */
export interface ThreadInfo {
  threadId: number;
  /** Structured-cloned from the parent's `new Worker(file, { workerData })`. */
  workerData: unknown;
}

/** A child as its parent sees it (separate stdout/stderr listeners, unlike the streams of the public `RuntimeProcess`). */
export interface ChildHandle {
  readonly pid: number;
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  write(data: string): void;
  closeStdin(): void;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
  readonly exit: Promise<number>;
  /** The parent's end of the message channel, when spawned with `ipc`. */
  readonly ipc?: IpcEndpoint;
}

export interface HttpRequestData {
  method: string;
  /** Path and query, as the server sees it (`/api?x=1`). */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface HttpResponseHead {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
}

/** A whole response, body buffered (`Kernel.request`, tests). */
export interface HttpResponseData extends HttpResponseHead {
  body: Uint8Array;
}

/**
 * A response as the server produces it: the head as soon as it is written, then
 * the body chunk by chunk (Server-Sent Events, chunked progress). Cancelling the
 * body hangs up, which the server sees as the client closing the connection.
 */
export interface HttpStreamResponse extends HttpResponseHead {
  body: ReadableStream<Uint8Array>;
}

export type HttpHandler = (request: HttpRequestData) => Promise<HttpStreamResponse>;

/**
 * One end of a raw byte pipe — an upgraded connection. The server end carries
 * whatever the server writes (a WebSocket server writes its `101` reply and then
 * frames), so packages like `ws` run their own framing over it unchanged.
 */
export interface ByteChannel {
  send(data: Uint8Array): void;
  /** Hang up; the other end hears `onClose`. */
  close(): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  /** The other end hung up. */
  onClose(listener: () => void): () => void;
  readonly closed: boolean;
}

/** Take over a connection a client asked to upgrade (`Upgrade: websocket`); `socket` is the server end. */
export type UpgradeHandler = (request: HttpRequestData, socket: ByteChannel) => void;

export interface System {
  fs: VirtualFileSystem;
  /** Outbound network (registry, `http.request`, `fetch`). */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  spawn(command: string, args: string[], options?: ProcessOptions): ChildHandle;
  /**
   * Register a virtual server; throws `EADDRINUSE`. Port 0 picks a free one.
   * `upgrade` takes over connections that ask to upgrade (WebSockets). Returns the port and an unlisten.
   */
  listen(port: number, handler: HttpHandler, upgrade?: UpgradeHandler): { port: number; close(): void };
  /** Send a request to a virtual server in this runtime (`http.get('http://localhost:3000')`); undefined when nothing listens. The body streams. */
  loopback(port: number, request: HttpRequestData): Promise<HttpStreamResponse | undefined>;
  /** Where a browser reaches a server on `port` (the preview URL), if known. */
  serverUrl(port: number): string | undefined;
  /** Tell the host a server is reachable without opening a port; used by the dev-server handoff. */
  announceServer(port: number, url: string): void;
  /** The in-browser dev server's preview URL, for `vite`/`react-scripts start` handoff. */
  previewUrl?: string;
  /**
   * This program has the JS realm to itself (one process per Web Worker): node
   * may install `process`, `Buffer`, timers on `globalThis`, and the host routes
   * the realm's uncaught errors to it through `trapUncaught`.
   */
  ownsRealm?: boolean;
  /** Register for the realm's uncaught errors and unhandled rejections. */
  trapUncaught?(handler: (error: unknown) => void): () => void;
  /** npm registry and cache for `npm install`. */
  registry?: string;
  packageCache?: PackageCache;
}

export interface ProgramContext {
  /** Arguments after the program name. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  io: ProgramIO;
  system: System;
  /** Aborted by kill(): in-process programs stop at their next await. */
  signal: AbortSignal;
  /** The channel to the parent, when it spawned this process with `ipc` (`process.send`). */
  ipc?: IpcEndpoint;
  /** Set when this process is a worker thread. */
  thread?: ThreadInfo;
}

/** A program resolves with its exit code. */
export type Program = (ctx: ProgramContext) => Promise<number>;
