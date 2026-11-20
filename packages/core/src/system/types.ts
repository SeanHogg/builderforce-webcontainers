/**
 * The contract between programs (node, the shell, npm, coreutils) and whatever
 * hosts them. Programs only ever see these ports, so the same program code runs
 * in-process under the core `Kernel` (Node tests) and one-per-Web-Worker in the
 * browser runtime, where `spawn` and `listen` are relayed to the page.
 */
import type { VirtualFileSystem } from '../vfs.js';
import type { PackageCache } from '../installer/registry.js';
import type { IpcEndpoint } from './ipc.js';
import type { SecurityContext } from './securityContext.js';

export interface TerminalPort {
  cols: number;
  rows: number;
  onResize(listener: (cols: number, rows: number) => void): () => void;
  /** Raw mode: the program handles keystrokes itself (no line editing, no echo). */
  setRawMode(raw: boolean): void;
}

/** What flows through stdio: text, or bytes kept as bytes (binary protocols over a child's pipes). */
export type StdioChunk = string | Uint8Array;

export interface ProgramIO {
  stdout(chunk: StdioChunk): void;
  stderr(chunk: StdioChunk): void;
  /** Stdin chunks as they arrive, bytes or text as written; `null` is end-of-file. Buffered until the first subscriber. Text consumers wrap the listener in `textChunks`. */
  onStdin(listener: (chunk: StdioChunk | null) => void): () => void;
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
  /** Output as the child wrote it: text, or bytes kept as bytes. */
  onStdout(listener: (chunk: StdioChunk) => void): () => void;
  onStderr(listener: (chunk: StdioChunk) => void): () => void;
  write(data: StdioChunk): void;
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
 * One end of a raw byte pipe — an upgraded connection, or a raw TCP connection.
 * The server end carries whatever the server writes (a WebSocket server writes
 * its `101` reply and then frames), so packages like `ws` and `pg` run their own
 * protocol over it unchanged. Bytes only: never a SharedArrayBuffer.
 */
export interface ByteChannel {
  send(data: Uint8Array): void;
  /** Hang up; the other end hears `onClose`. */
  close(): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  /** The other end hung up. */
  onClose(listener: () => void): () => void;
  /**
   * Flow control: this end's reader credits explicitly with `consumed` from now
   * on. Without it, everything delivered here is credited at once, so a reader
   * that never credits cannot stall the writer.
   */
  manualFlowControl(): void;
  /** Flow control: this end's reader has consumed `bytes` of what arrived (the other end hears `onConsumed`). */
  consumed(bytes: number): void;
  /** Flow control: the other end's reader consumed `bytes` of what this end sent. */
  onConsumed(listener: (bytes: number) => void): () => void;
  readonly closed: boolean;
}

/** Take over a connection a client asked to upgrade (`Upgrade: websocket`); `socket` is the server end. */
export type UpgradeHandler = (request: HttpRequestData, socket: ByteChannel) => void;

/**
 * Take a raw TCP connection (`net.Server`'s `'connection'`); `socket` is the server end.
 * `caller` is who dialled, as the page-side `PortRegistry` knows it (never what
 * the dialling process claims) — page-side listeners such as the database
 * gateway decide on it; a listener in a process Worker never receives it.
 */
export type ConnectionHandler = (socket: ByteChannel, caller?: SecurityContext) => void;

/**
 * A server's place on a port. Where the port table lives elsewhere (a process
 * Worker asks the page), `ready` settles once the table answered: it rejects
 * with an `EADDRINUSE` error when another process took the port first. Without
 * `ready` the registration is final when `listen` returns.
 */
export interface ListenRegistration {
  port: number;
  close(): void;
  ready?: Promise<void>;
}

/** The error a refused `listen` reports, as Node's `net`/`http` servers emit it. */
export function addressInUseError(port: number): Error {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use :::${port}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: '::', port });
}

export interface System {
  fs: VirtualFileSystem;
  /** Outbound network (registry, `http.request`, `fetch`). */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  spawn(command: string, args: string[], options?: ProcessOptions): ChildHandle;
  /**
   * Register a virtual server; throws `EADDRINUSE`. Port 0 picks a free one.
   * `upgrade` takes over connections that ask to upgrade (WebSockets);
   * `connection` takes raw TCP connections (`net.createServer`). Returns the port and an unlisten.
   */
  listen(port: number, handler: HttpHandler, upgrade?: UpgradeHandler, connection?: ConnectionHandler): ListenRegistration;
  /**
   * Open a raw TCP connection to a server on `port` in this runtime (loopback
   * only); resolves with the client end, or undefined when nothing listens there
   * (`ECONNREFUSED`).
   */
  connect(port: number): Promise<ByteChannel | undefined>;
  /** Send a request to a virtual server in this runtime (`http.get('http://localhost:3000')`); undefined when nothing listens. The body streams. */
  loopback(port: number, request: HttpRequestData): Promise<HttpStreamResponse | undefined>;
  /** Where a browser reaches a server on `port` (the preview URL), if known. */
  serverUrl(port: number): string | undefined;
  /**
   * Tell the host a server is reachable without opening a port; used by the
   * dev-server handoff, which names the directory it serves (`root`, its working
   * directory) so the host's dev server serves that directory at `url`.
   * Returns the withdrawal, when the host tracks handoffs: called when the
   * handoff ends (interrupted) so the host stops serving that directory.
   */
  announceServer(port: number, url: string, root?: string): (() => void) | void;
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
