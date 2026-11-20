/**
 * Helpers for the local launcher's server tests: a temporary project on disk and
 * raw requests to 127.0.0.1 with any `Host` and SNI name (the launcher tells its
 * origins apart by them) — https trusting the launcher's local CA, or http.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** The launcher's local CA (PEM) the https requests trust; undefined: plain http (`tls: false`). */
let trustedCa: string | undefined;

/** Trust `pem` for the requests that follow (the launcher's `caCertPath` contents). */
export function trustCa(pem: string | undefined): void {
  trustedCa = pem;
}

/** The SNI name for a `Host` value: its name without the port; none for an IP literal (clients send no SNI for one). */
function serverNameOf(host: string): string | undefined {
  const name = host.replace(/:\d+$/, '');
  return /^[\d.]+$/.test(name) || name.startsWith('[') ? undefined : name;
}

/** The TLS options of a request to the launcher naming `host` (SNI `servername`, default the host's name). */
export function tlsFor(host: string, servername?: string): { ca: string; servername?: string } | undefined {
  if (trustedCa === undefined) return undefined;
  const name = servername ?? serverNameOf(host);
  return name === undefined ? { ca: trustedCa } : { ca: trustedCa, servername: name };
}

/** A request to the launcher on 127.0.0.1:`port` (https with the trusted CA, else http). */
export function launcherRequest(options: RequestOptions & { headers: Record<string, string> }, servername?: string): ClientRequest {
  const tls = tlsFor(String(options.headers.Host ?? ''), servername);
  return tls ? httpsRequest({ ...options, ...tls }) : request(options);
}

/**
 * One request to the launcher on `port`, as if the browser named `host`. Over https the
 * SNI name follows `host` unless `servername` says otherwise (to test the `Host` guard
 * behind a valid handshake).
 */
export function get(port: number, host: string, path: string, headers: Record<string, string> = {}, method = 'GET', servername?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = launcherRequest({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, servername);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The token in a launcher URL (`…/#token=…`). */
export function tokenOf(url: string): string {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  if (!token) throw new Error(`No token in ${url}`);
  return token;
}

/** A temporary directory with `files` written in it (`path → contents`); `cleanup()` removes it. */
export function tempProject(files: Record<string, string | Uint8Array>): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'bfwc-launch-'));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal v1 manifest: one Node frontend on port 3000. */
export const NODE_MANIFEST = JSON.stringify({
  version: 1,
  name: 'demo',
  services: { web: { runtime: 'node', command: 'node server.js', port: 3000, role: 'frontend', readiness: { http: '/' } } },
});
