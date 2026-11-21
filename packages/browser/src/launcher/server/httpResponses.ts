/**
 * Writing the launcher's answers: one place that sets status, headers and body,
 * and honours `HEAD`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HeaderSet } from './previewHeaders.js';

export function send(req: IncomingMessage, res: ServerResponse, status: number, headers: HeaderSet, body?: string | Buffer): void {
  const bytes = body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...headers, ...(bytes ? { 'Content-Length': String(bytes.byteLength) } : {}) });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

/** Whether a header presents exactly `token`, compared in constant time (the launch token, the report token). */
export function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function sendText(req: IncomingMessage, res: ServerResponse, status: number, headers: HeaderSet, text: string): void {
  send(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, text);
}

/** The request's path (no query), or null when it is not a well-formed origin-form target. */
export function requestUrl(req: IncomingMessage, origin: string): URL | null {
  const target = req.url ?? '';
  if (!target.startsWith('/')) return null;
  try {
    return new URL(target, origin);
  } catch {
    return null;
  }
}
