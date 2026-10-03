/**
 * Messages between the page (the process host, which owns the master file
 * system and the port table) and one process Worker. Everything is plain
 * structured-clone data; file contents travel as strings or bytes.
 */
import type { FileContent, HttpRequestData, HttpResponseData } from '@seanhogg/builderforce-webcontainers-core';

export type FsOp = { op: 'write'; path: string; content: FileContent } | { op: 'remove'; path: string } | { op: 'mkdir'; path: string };

export interface StartMessage {
  type: 'start';
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  terminal?: { cols: number; rows: number };
  files: Array<[string, FileContent]>;
  dirs: string[];
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

/** page → worker */
export type HostToWorker =
  | StartMessage
  | { type: 'stdin'; data: string | null }
  | { type: 'kill'; signal: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'fs'; ops: FsOp[] }
  | { type: 'ports'; open: number[]; closed: number[] }
  | { type: 'child-out'; childId: number; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'child-exit'; childId: number; code: number }
  | { type: 'child-error'; childId: number; code: string; message: string }
  | { type: 'http-request'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'loopback-response'; reqId: number; response: HttpResponseData | null };

/** worker → page */
export type WorkerToHost =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'fs'; ops: FsOp[] }
  | { type: 'spawn'; childId: number; command: string; args: string[]; cwd?: string; env?: Record<string, string>; terminal?: { cols: number; rows: number } }
  | { type: 'child-stdin'; childId: number; data: string | null }
  | { type: 'child-kill'; childId: number; signal: string }
  | { type: 'child-resize'; childId: number; cols: number; rows: number }
  | { type: 'listen'; port: number }
  | { type: 'unlisten'; port: number }
  | { type: 'http-response'; reqId: number; response: HttpResponseData }
  | { type: 'loopback'; reqId: number; port: number; request: HttpRequestData }
  | { type: 'server-ready'; port: number; url: string };

/** The preview-relative URL a virtual server on `port` is reachable at. */
export function portPath(previewBase: string, port: number): string {
  return `${previewBase}__port/${port}/`;
}
