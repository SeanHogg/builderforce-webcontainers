/**
 * `php -S` served request-driven: no socket is bound; each request to the
 * process's virtual port runs through php-wasm's request runner (CGI-style
 * `$_SERVER`, `$_GET`, `$_POST`, `$_COOKIE`, `$_FILES`, `php://input`), with
 * `PHP_SAPI === 'cli-server'`, and its answer — status, headers (each
 * `Set-Cookie` kept), body — is streamed back as PHP writes it. This is an
 * `HttpHandler`, so anything that routes a port to a handler can serve it.
 *
 * Routing follows PHP's built-in server:
 * - a router script runs for every request; when it `return false`s, the
 *   request is served as if there were no router;
 * - otherwise a `.php` file runs, any other file is sent as is (by extension's
 *   MIME type), a directory serves its `index.php`/`index.html`;
 * - `/script.php/extra` runs `script.php` with `PATH_INFO=/extra`;
 * - a path with no file extension that matches nothing falls back to the
 *   nearest `index.php`/`index.html` up to the document root (front
 *   controllers: Slim, Laravel's `public/index.php`), else 404.
 *
 * Every request runs through a small front script (outside the project) that
 * applies `-d` settings and notices a router's `return false`.
 */
import { bytesStream, extname, join, mimeFor, normalizePath, textResponse, type HttpHandler, type HttpRequestData, type HttpStreamResponse } from '@seanhogg/builderforce-webcontainers-core';
import type { PhpServerSpec } from './phpCommand.js';
import { phpString } from './phpLiteral.js';
import type { PhpLike, PhpStreamedResponse } from './phpLoader.js';
import { byteStream, drainText } from './phpStreams.js';

/** Where the front script lives: outside the project, so it never syncs to the page. */
export const FRONT_SCRIPT = '/bfwc/php-server-front.php';

/** The header a router's `return false` is signalled with (never sent to the client). */
const DECLINED = 'x-bfwc-router-declined';

export interface PhpWebServer {
  readonly spec: PhpServerSpec;
  readonly handle: HttpHandler;
}

export interface PhpWebServerContext {
  php: PhpLike;
  /** The file system calls routing needs (PHP paths). */
  files: { isFile(path: string): boolean; isDir(path: string): boolean; read(path: string): Uint8Array; write(path: string, data: string): void; mkdirTree(path: string): void };
  /** Absolute PHP paths. */
  docroot: string;
  router?: string;
  /** The process's environment (`getenv`, `$_ENV`). */
  env: Record<string, string>;
  /** Request logs and PHP's warnings. */
  log(text: string): void;
  phpVersion: string;
}


/** The front script: `-d` settings, then the target (its path in `SCRIPT_FILENAME`), noticing a router's `return false`. */
export function frontScript(ini: Readonly<Record<string, string>>): string {
  const settings = Object.entries(ini).map(([name, value]) => `ini_set(${phpString(name)}, ${phpString(value)});`);
  return [
    '<?php',
    ...settings,
    // php-wasm always sets HTTPS ('off' over plain HTTP); PHP's built-in server never does.
    `if (($_SERVER['HTTPS'] ?? '') === 'off') unset($_SERVER['HTTPS']);`,
    `if ((require $_SERVER['SCRIPT_FILENAME']) === false && !headers_sent()) header('X-Bfwc-Router-Declined: 1');`,
    '',
  ].join('\n');
}

type Target = { kind: 'script'; file: string; scriptName: string; pathInfo?: string } | { kind: 'file'; file: string } | { kind: 'missing' };

const hasExtension = (path: string) => /\.[^/]+$/.test(path);

/** Which file serves `pathname` (a decoded URL path), as PHP's built-in server picks it. */
export function routeRequest(pathname: string, docroot: string, files: Pick<PhpWebServerContext['files'], 'isFile' | 'isDir'>): Target {
  const path = normalizePath(pathname);
  const at = (url: string) => (url === '/' ? docroot : join(docroot, url));
  const serve = (file: string, url: string, pathInfo?: string): Target => (file.endsWith('.php') ? { kind: 'script', file, scriptName: url, pathInfo } : { kind: 'file', file });
  const indexOf = (dirUrl: string) => ['index.php', 'index.html'].map((name) => ({ url: join(dirUrl, name), file: join(at(dirUrl), name) })).find(({ file }) => files.isFile(file));
  if (files.isFile(at(path))) return serve(at(path), path);
  if (files.isDir(at(path))) {
    const index = indexOf(path);
    if (index) return serve(index.file, index.url);
  }
  // `/index.php/extra`: the longest `.php` prefix runs, the rest is PATH_INFO.
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i > 0; i--) {
    const url = `/${segments.slice(0, i).join('/')}`;
    if (url.endsWith('.php') && files.isFile(at(url))) return serve(at(url), url, `/${segments.slice(i).join('/')}`);
  }
  if (hasExtension(path)) return { kind: 'missing' };
  for (let i = segments.length; i >= 0; i--) {
    const dirUrl = `/${segments.slice(0, i).join('/')}`;
    if (!files.isDir(at(dirUrl))) continue;
    const index = indexOf(dirUrl);
    if (index) return serve(index.file, index.url, path === dirUrl ? undefined : path.slice(dirUrl === '/' ? 0 : dirUrl.length) || undefined);
  }
  return { kind: 'missing' };
}

const notFound = (pathname: string): HttpStreamResponse => ({
  status: 404,
  headers: { 'content-type': 'text/html; charset=UTF-8' },
  body: bytesStream(new TextEncoder().encode(`<!doctype html><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested resource <code>${pathname.replace(/[<>&"]/g, '')}</code> was not found on this server.</p></body></html>`)),
});

/** A head's headers from php-wasm's (lower-case names; one value, or an array for repeated ones like Set-Cookie). */
export function headersOf(raw: Record<string, string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (key === DECLINED || !values.length) continue;
    out[key] = values.length === 1 ? values[0]! : [...values];
  }
  return out;
}

/** Start serving `spec` (paths already PHP paths, docroot and router absolute). */
export async function startPhpWebServer(spec: PhpServerSpec, context: PhpWebServerContext): Promise<PhpWebServer> {
  const { php, files, docroot, router } = context;
  files.mkdirTree(FRONT_SCRIPT.slice(0, FRONT_SCRIPT.lastIndexOf('/')));
  files.write(FRONT_SCRIPT, frontScript(spec.ini));
  php.chdir(docroot);
  const host = spec.host.replace(/^\[|\]$/g, '');
  /** A request without a Host header (an in-runtime client) is addressed to the server itself, as `php -S` would see it. */
  const defaultHost = `${host.includes(':') ? `[${host}]` : host}:${spec.port}`;

  const run = async (request: HttpRequestData, script: Extract<Target, { kind: 'script' }>): Promise<PhpStreamedResponse> => {
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
    const server: Record<string, string> = {
      DOCUMENT_ROOT: docroot,
      SCRIPT_FILENAME: script.file,
      SCRIPT_NAME: script.scriptName,
      PHP_SELF: script.scriptName + (script.pathInfo ?? ''),
      SERVER_NAME: host,
      SERVER_PORT: String(spec.port),
      SERVER_PROTOCOL: 'HTTP/1.1',
      SERVER_SOFTWARE: `PHP ${context.phpVersion} Development Server (php-wasm, BuilderForce WebContainers)`,
      REMOTE_ADDR: '127.0.0.1',
      QUERY_STRING: query,
    };
    if (script.pathInfo) server.PATH_INFO = script.pathInfo;
    return php.runStream({ scriptPath: FRONT_SCRIPT, relativeUri: request.url, method: request.method.toUpperCase(), headers: { host: defaultHost, ...request.headers }, protocol: 'http', body: request.body ?? undefined, env: context.env, $_SERVER: server });
  };

  const respond = async (request: HttpRequestData, pathname: string, target: Target): Promise<HttpStreamResponse | 'declined'> => {
    if (target.kind === 'missing') return notFound(pathname);
    if (target.kind === 'file') return { status: 200, headers: { 'content-type': mimeFor(extname(target.file)) }, body: bytesStream(files.read(target.file)) };
    const response = await run(request, target);
    void drainText(response.stderr, context.log).catch(() => undefined);
    const [status, raw] = await Promise.all([response.httpStatusCode, response.headers]);
    if (raw[DECLINED]?.length) {
      void response.stdout.cancel();
      return 'declined';
    }
    return { status, headers: headersOf(raw), body: byteStream(response.stdout) };
  };

  const handle: HttpHandler = async (request) => {
    const raw = request.url.split('?')[0]!.split('#')[0]!;
    let pathname: string;
    try {
      pathname = decodeURIComponent(raw) || '/';
    } catch {
      return textResponse(400, 'Bad Request');
    }
    try {
      let response = router ? await respond(request, pathname, { kind: 'script', file: router, scriptName: router.startsWith(`${docroot}/`) ? router.slice(docroot.length) : `/${router.split('/').pop()}` }) : 'declined';
      if (response === 'declined') {
        response = await respond(request, pathname, routeRequest(pathname, docroot, files));
        if (response === 'declined') response = notFound(pathname); // a front controller found by fallback declined too
      }
      context.log(`[${response.status}]: ${request.method.toUpperCase()} ${request.url}\n`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log(`[500]: ${request.method.toUpperCase()} ${request.url} - ${message}\n`);
      return textResponse(500, `PHP failed to handle the request: ${message}`);
    }
  };

  return { spec, handle };
}
