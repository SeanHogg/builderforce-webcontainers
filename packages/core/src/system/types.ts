/**
 * The contract between programs (node, the shell, npm, coreutils) and whatever
 * hosts them. Programs only ever see these ports, so the same program code runs
 * in-process under the core `Kernel` (Node tests) and one-per-Web-Worker in the
 * browser runtime, where `spawn` and `listen` are relayed to the page.
 */
import type { VirtualFileSystem } from '../vfs.js';
import type { PackageCache } from '../installer/registry.js';

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

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Attach to a terminal of this size (`isTTY`, line discipline, `\r\n` output). */
  terminal?: { cols: number; rows: number };
}

/** A child as its parent sees it (separate stdout/stderr, unlike the public API). */
export interface ChildHandle {
  readonly pid: number;
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  write(data: string): void;
  closeStdin(): void;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
  readonly exit: Promise<number>;
}

export interface HttpRequestData {
  method: string;
  /** Path and query, as the server sees it (`/api?x=1`). */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface HttpResponseData {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  body: Uint8Array;
}

export type HttpHandler = (request: HttpRequestData) => Promise<HttpResponseData>;

export interface System {
  fs: VirtualFileSystem;
  /** Outbound network (registry, `http.request`, `fetch`). */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  spawn(command: string, args: string[], options?: SpawnOptions): ChildHandle;
  /** Register a virtual server; throws `EADDRINUSE`. Port 0 picks a free one. Returns the port and an unlisten. */
  listen(port: number, handler: HttpHandler): { port: number; close(): void };
  /** Send a request to a virtual server in this runtime (`http.get('http://localhost:3000')`); undefined when nothing listens. */
  loopback(port: number, request: HttpRequestData): Promise<HttpResponseData | undefined>;
  /** Where a browser reaches a server on `port` (the preview URL), if known. */
  serverUrl(port: number): string | undefined;
  /** Tell the host a server is ready (`server-ready`); used by the dev-server handoff. */
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
}

/** A program resolves with its exit code. */
export type Program = (ctx: ProgramContext) => Promise<number>;
