/**
 * Messages between the page (the process host, which owns the master file
 * system and the port table) and one process Worker. Everything is plain
 * structured-clone data; file contents travel as strings or bytes, except in
 * the start snapshot, whose files travel packed in one ArrayBuffer.
 *
 * HTTP responses stream in both directions with the same three messages: a
 * `response-head`, `response-chunk`s as the server writes, a `response-end`.
 * Worker → page they answer an `http-request` (ids the page allocated); page →
 * worker they answer a `loopback` (ids the worker allocated). `request-cancel`
 * goes the other way: the reader hung up. Connections to a process's servers
 * are opened by the page — upgraded ones (WebSockets) with `socket-open`, raw
 * TCP with `socket-accept` — and connections a process dials (`net.connect`)
 * by the worker (`dial`); both carry raw bytes and flow-control credits both
 * ways (connectionRelay.ts on the page, workerConnections.ts in the worker).
 *
 * A server's `listen` is answered: `listened` once the page registered it,
 * `listen-failed` when it cannot (the port is taken), so the process learns it
 * does not own the port.
 *
 * A message channel (fork, worker threads) is `ipc` / `ipc-disconnect` between a
 * process and the page (its parent's side), and `child-ipc` /
 * `child-ipc-disconnect` between a parent process and the page (its child's side).
 */
import type { HttpRequestData, HttpResponseHead, StdioChunk, ThreadInfo, VfsDelta, VfsOp, VfsSnapshot } from '@seanhogg/builderforce-webcontainers-core';
import type { TrainingPageMessage, TrainingStartOptions, TrainingWorkerMessage } from '../runtimes/python/trainingProtocol.js';

/** One file-system change, either way (the core journal's op). */
export type FsOp = VfsOp;

/** Which process Worker runs a command: the Node runtime's, the Python runtime's (Pyodide), the PHP runtime's (php-wasm), the .NET runtime's (Mono), or the Rust runtime's (prebuilt wasm32-wasip1 on the WASI host). */
export type WorkerKind = 'node' | 'python' | 'php' | 'dotnet' | 'rust';

/** A host-provided Python extension: a module the Python Worker imports, whose export builds it (runtimes/python/pythonExtensions.ts). */
export interface PythonExtensionRef {
  moduleUrl: string;
  exportName: string;
}

/** One successful `pip install`: its requirement specs and the package indexes they came from (replayed together, never mixed with another's). */
export interface PipInstall {
  specs: string[];
  indexUrls: string[];
}

/**
 * The host's instructions to a Python process Worker. They travel in the start
 * message, never the environment, so a program's env cannot redirect where
 * Pyodide or an extension is loaded from.
 */
export interface PythonStartOptions {
  /** Where Pyodide is served. Default: the pinned jsDelivr build. */
  indexURL?: string;
  extensions?: PythonExtensionRef[];
  /** This session's earlier `pip install`s, in order: each replayed with only its own indexes. */
  installs?: PipInstall[];
  /** Only for the root process the Python provider spawned for a `training` service (runtimes/python/trainingChannel.ts). */
  training?: TrainingStartOptions;
}

/** Where the PHP runtime's Composer installs come from (runtimes/php/composer/packagist.ts). */
export interface ComposerSourceOptions {
  /** Package metadata URL template with `{name}` (Packagist's package API, or a `p2` mirror). Default: Packagist's package API. */
  repositoryUrl?: string;
  /** A URL prefix dist zip URLs are appended to (encoded): a CORS proxy for GitHub's zipballs. Default: none (jsDelivr's GitHub mirror). */
  distProxy?: string;
}

/**
 * The host's instructions to a PHP process Worker. Like Python's, they travel
 * in the start message, never the environment, so a program's env cannot
 * redirect where php-wasm or Composer packages are loaded from.
 */
export interface PhpStartOptions {
  /** Where php-wasm is served (a jsDelivr-style npm CDN base). Default: jsDelivr. */
  baseUrl?: string;
  /** PHP version (`8.1`–`8.4`). Default 8.3. */
  phpVersion?: string;
  composer?: ComposerSourceOptions;
}

/**
 * The host's instructions to a .NET process Worker. Like Python's and PHP's,
 * they travel in the start message, never the environment, so a program's env
 * cannot redirect where the runtime bundle is loaded from.
 */
export interface DotnetStartOptions {
  /**
   * Where the .NET runtime bundle (scripts/build-dotnet-runtime.mjs) is served:
   * absolute, CORS-enabled; in relay mode, reachable from the preview origin.
   * There is no default — the bundle is the host's artifact.
   */
  bundleUrl?: string;
}

export interface StartMessage {
  type: 'start';
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  terminal?: { cols: number; rows: number };
  /** A message channel to the parent is open (`process.send`, a thread's `parentPort`). */
  ipc?: boolean;
  thread?: ThreadInfo;
  /**
   * The file system: the host's cached pack (one ArrayBuffer, shared by every
   * spawn until it is rebuilt) plus the changes since it — or, for a warm worker
   * that a `prime` already mounted, only the changes since that.
   */
  snapshot: VfsSnapshot | VfsDelta;
  /** Ports already listening anywhere in the runtime (so `listen` can fail fast with EADDRINUSE). */
  ports: number[];
  /** `/__bfwc/<id>/` on the preview origin, for `serverUrl`. */
  previewOrigin: string;
  previewBase: string;
  previewUrl?: string;
  registry?: string;
  /** Use Cache Storage for npm tarballs. */
  packageCache: boolean;
  /** Set for a Python process. */
  python?: PythonStartOptions;
  /** Set for a PHP process. */
  php?: PhpStartOptions;
  /** Set for a .NET process. */
  dotnet?: DotnetStartOptions;
  /**
   * Commands another Worker kind runs (a RegExp source over the command's base
   * name): a Node process spawns them through the page instead of resolving
   * them itself.
   */
  foreignCommands?: string;
}

/** A streamed response, chunk by chunk; `head: null` means nothing listens on that port (loopback only). */
export type ResponseMessage =
  | { type: 'response-head'; reqId: number; head: HttpResponseHead | null }
  | { type: 'response-chunk'; reqId: number; data: Uint8Array }
  | { type: 'response-end'; reqId: number; error?: string };

/**
 * A connection to one of this process's servers — upgraded (a WebSocket) or raw
 * TCP — either way; ids allocated by the page. `socket-ack` is flow control:
 * the receiving side's reader consumed `bytes`.
 */
export type SocketMessage =
  | { type: 'socket-data'; connId: number; data: Uint8Array }
  | { type: 'socket-ack'; connId: number; bytes: number }
  | { type: 'socket-close'; connId: number };

/**
 * A raw TCP connection this process dialled (`net.connect`), either way; ids
 * allocated by the worker. `dial` asks, `dial-result` answers (`ok: false`:
 * nothing listens, ECONNREFUSED).
 */
export type DialMessage =
  | { type: 'dial-data'; connId: number; data: Uint8Array }
  | { type: 'dial-ack'; connId: number; bytes: number }
  | { type: 'dial-close'; connId: number };

/** Message-channel traffic: to/from this process's parent (`ipc`), or one of its children (`child-ipc`). */
export type IpcMessage =
  | { type: 'ipc'; data: unknown }
  | { type: 'ipc-disconnect' }
  | { type: 'child-ipc'; childId: number; data: unknown }
  | { type: 'child-ipc-disconnect'; childId: number };

/** page → worker */
export type HostToWorker =
  /** A warm worker: mount the file system now, ahead of the `start` that will name the program. */
  | { type: 'prime'; snapshot: VfsSnapshot }
  | StartMessage
  | { type: 'stdin'; data: StdioChunk | null }
  | { type: 'kill'; signal: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'fs'; ops: FsOp[] }
  | { type: 'ports'; open: number[]; closed: number[] }
  /** The page registered the process's `listen` (`id` echoes the listen's). */
  | { type: 'listened'; port: number; id?: number }
  /** The process's `listen` on `port` was refused (another process holds it): it does not own the port. */
  | { type: 'listen-failed'; port: number; message: string; id?: number }
  | { type: 'child-out'; childId: number; stream: 'stdout' | 'stderr'; data: StdioChunk }
  | { type: 'child-exit'; childId: number; code: number }
  | { type: 'child-error'; childId: number; code: string; message: string }
  | { type: 'http-request'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'request-cancel'; reqId: number }
  | { type: 'socket-open'; connId: number; port: number; request: HttpRequestData }
  /** A raw TCP connection to the `net.Server` on `port`. */
  | { type: 'socket-accept'; connId: number; port: number }
  | { type: 'dial-result'; connId: number; ok: boolean }
  /** A training process's checkpoint request and save acknowledgements (runtimes/python/trainingProtocol.ts). */
  | TrainingPageMessage
  | ResponseMessage
  | SocketMessage
  | DialMessage
  | IpcMessage;

/** worker → page */
export type WorkerToHost =
  | { type: 'stdout' | 'stderr'; data: StdioChunk }
  | { type: 'exit'; code: number }
  /** A spare acknowledging its `prime`: the file system is mounted, it may be started. */
  | { type: 'primed' }
  | { type: 'fs'; ops: FsOp[] }
  | { type: 'spawn'; childId: number; command: string; args: string[]; cwd?: string; env?: Record<string, string>; terminal?: { cols: number; rows: number }; ipc?: boolean; thread?: ThreadInfo; detached?: boolean }
  | { type: 'child-stdin'; childId: number; data: StdioChunk | null }
  | { type: 'child-kill'; childId: number; signal: string }
  | { type: 'child-resize'; childId: number; cols: number; rows: number }
  /** `tcp`: the server takes raw TCP connections (`net.Server`). `id`: echoed by the page's `listened` / `listen-failed`. */
  | { type: 'listen'; port: number; tcp?: boolean; id?: number }
  | { type: 'unlisten'; port: number }
  | { type: 'loopback'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'request-cancel'; reqId: number }
  /** `root`: a dev-server handoff's working directory (the directory it asks the dev server to serve). */
  | { type: 'listening'; port: number; url: string; root?: string }
  /** Open a raw TCP connection to whatever listens on `port`, in any process. */
  | { type: 'dial'; connId: number; port: number }
  /** A Python process's `pip install` succeeded: record it for the processes started after it. */
  | ({ type: 'python-installed' } & PipInstall)
  /** A PHP process read the running PHP's version and extensions (the page's `php` provider checks services against them). */
  | { type: 'php-platform'; phpVersion: string; extensions: string[] }
  /** A training process's saved artifacts (runtimes/python/trainingProtocol.ts). */
  | TrainingWorkerMessage
  | ResponseMessage
  | SocketMessage
  | DialMessage
  | IpcMessage;

/** The preview-relative URL a virtual server on `port` is reachable at. */
export function portPath(previewBase: string, port: number): string {
  return `${previewBase}__port/${port}/`;
}
