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
 * A message channel (fork, worker threads) is `ipc` / `ipc-disconnect` between a
 * process and the page (its parent's side), and `child-ipc` /
 * `child-ipc-disconnect` between a parent process and the page (its child's side).
 */
import type { HttpRequestData, HttpResponseHead, StdioChunk, ThreadInfo, VfsDelta, VfsOp, VfsSnapshot } from '@seanhogg/builderforce-webcontainers-core';

/** One file-system change, either way (the core journal's op). */
export type FsOp = VfsOp;

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
  | { type: 'child-out'; childId: number; stream: 'stdout' | 'stderr'; data: StdioChunk }
  | { type: 'child-exit'; childId: number; code: number }
  | { type: 'child-error'; childId: number; code: string; message: string }
  | { type: 'http-request'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'request-cancel'; reqId: number }
  | { type: 'socket-open'; connId: number; port: number; request: HttpRequestData }
  /** A raw TCP connection to the `net.Server` on `port`. */
  | { type: 'socket-accept'; connId: number; port: number }
  | { type: 'dial-result'; connId: number; ok: boolean }
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
  /** `tcp`: the server takes raw TCP connections (`net.Server`). */
  | { type: 'listen'; port: number; tcp?: boolean }
  | { type: 'unlisten'; port: number }
  | { type: 'loopback'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'request-cancel'; reqId: number }
  | { type: 'listening'; port: number; url: string }
  /** Open a raw TCP connection to whatever listens on `port`, in any process. */
  | { type: 'dial'; connId: number; port: number }
  | ResponseMessage
  | SocketMessage
  | DialMessage
  | IpcMessage;

/** The preview-relative URL a virtual server on `port` is reachable at. */
export function portPath(previewBase: string, port: number): string {
  return `${previewBase}__port/${port}/`;
}
