/**
 * Answering preview requests addressed to virtual servers (`/__port/<n>/…`).
 * The request reaches the server carrying the cookies the host holds for that
 * port; the response streams back to the service worker as the server writes
 * it (head, then `chunk` messages, then `end`); its `Set-Cookie`s go into the
 * jar (a service worker could not set them); and an HTML page gets the preview
 * bridge — the WebSocket shim and `document.cookie` — injected after `<head>`.
 */
import {
  bridgeInsertionPoint,
  drainBody,
  errorBridgeScript,
  scriptTag,
  parsePortPath,
  previewCookieScript,
  previewSocketScript,
  readBody,
  textResponse,
  type CookieJar,
  type PortCookieJars,
} from '@seanhogg/builderforce-webcontainers-core';
import type { WireReply, WireRequest, WireResponse } from '../protocol.js';
import type { ProcessHost } from './processHost.js';

export interface PortResponderOptions {
  /** The runtime's cookie jars. Without them, the browser's own `Cookie` header passes through and `Set-Cookie` is lost. */
  cookies?: PortCookieJars;
  /** Inject the preview bridge (errors and console to the host, WebSocket shim, `document.cookie`) into HTML pages. Default true. */
  bridge?: boolean;
  /** The host's preview scripts, read per page so `setPreviewScripts` applies to virtual servers too. */
  scripts?: () => readonly string[];
}

export interface OpenedPortResponse {
  status: number;
  /** Flattened for a `Response` (`Set-Cookie` removed — it went to the jar). */
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

const NO_STORE = { 'cache-control': 'no-store' };

function headerKey(headers: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

/** Send a preview request to its virtual server; resolves with the head and a body that streams. */
export async function openPortResponse(host: ProcessHost, request: WireRequest, options: PortResponderOptions = {}): Promise<OpenedPortResponse> {
  const target = parsePortPath(request.path)!;
  const jar = options.cookies?.jar(target.port);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) if (!jar || key.toLowerCase() !== 'cookie') headers[key] = value;
  const cookie = jar?.header(target.path);
  if (cookie) headers.cookie = cookie;
  const response =
    (await host.requestStream(target.port, { method: request.method ?? 'GET', url: target.path + request.search, headers, body: request.body ? new Uint8Array(request.body) : null })) ??
    textResponse(502, `Nothing is listening on port ${target.port}. Start a server (node server.js) first.`);

  const out: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === 'set-cookie') setCookies.push(...(Array.isArray(value) ? value : [value]));
    else out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  if (response.status === 502 && !headerKey(out, 'cache-control')) Object.assign(out, NO_STORE);
  jar?.store(setCookies, target.path);

  let body = response.body;
  const type = headerKey(out, 'content-type');
  // A compressed body cannot be edited in flight; such a page goes without the bridge.
  const hasBody = request.method !== 'HEAD' && response.status !== 204 && response.status !== 304;
  if (options.bridge !== false && hasBody && type && /^\s*text\/html/i.test(out[type]!) && !headerKey(out, 'content-encoding')) {
    body = injectBridge(body, bridgeFor(jar, target.path, options.scripts?.() ?? []));
    const length = headerKey(out, 'content-length');
    if (length) delete out[length];
    // The bridge pushes a `<meta charset>` past the 1,024-byte prescan; say it in the header instead.
    if (!/charset=/i.test(out[type]!)) out[type] = `${out[type]}; charset=utf-8`;
  }
  return { status: response.status, headers: out, body };
}

/** The same bridge a dev-server page gets (errors, console, sockets), plus cookies and the host's scripts. */
function bridgeFor(jar: CookieJar | undefined, path: string, scripts: readonly string[]): string {
  return [errorBridgeScript(), previewSocketScript(), jar ? previewCookieScript(jar.documentCookie(path)) : '', ...scripts.map(scriptTag)].join('');
}

/** Insert `script` into a streamed document, after `<head>` (see `bridgeInsertionPoint`), passing the rest through as it arrives. */
export function injectBridge(body: ReadableStream<Uint8Array>, script: string): ReadableStream<Uint8Array> {
  // windows-1252 maps every byte to one UTF-16 unit, so string indices are byte offsets.
  const latin1 = new TextDecoder('latin1');
  const bridge = new TextEncoder().encode(script);
  let held = new Uint8Array(0);
  let injected = false;
  const tryInject = (controller: TransformStreamDefaultController<Uint8Array>, complete: boolean) => {
    const at = bridgeInsertionPoint(latin1.decode(held), complete);
    if (at === undefined) return;
    if (at) controller.enqueue(held.subarray(0, at));
    controller.enqueue(bridge);
    if (at < held.byteLength) controller.enqueue(held.subarray(at));
    held = new Uint8Array(0);
    injected = true;
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (injected) return controller.enqueue(chunk);
        const joined = new Uint8Array(held.byteLength + chunk.byteLength);
        joined.set(held);
        joined.set(chunk, held.byteLength);
        held = joined;
        tryInject(controller, false);
      },
      flush(controller) {
        if (!injected) tryInject(controller, true);
      },
    }),
  );
}

/** A transferable copy of a chunk. */
const transferable = (data: Uint8Array) => new Uint8Array(data).buffer as ArrayBuffer;

/** Answer a preview request with the whole body (tests, simple hosts). The preview path streams instead: {@link createPortResponder}. */
export async function servePortRequest(host: ProcessHost, request: WireRequest, options?: PortResponderOptions): Promise<{ message: WireResponse; transfer: Transferable[] }> {
  const opened = await openPortResponse(host, request, options);
  const body = transferable(await readBody(opened.body));
  return { message: { type: 'response', reqId: request.reqId, status: opened.status, headers: opened.headers, body }, transfer: [body] };
}

export interface PortResponder {
  /** Answer one preview request: post the head, then the body chunk by chunk as the server writes it. */
  serve(request: WireRequest, post: (reply: WireReply, transfer: Transferable[]) => void): Promise<void>;
  /** The preview stopped reading `reqId`: hang up on the server. */
  cancel(reqId: number): void;
  /** Hang up on every response still streaming. */
  dispose(): void;
}

/** One per service-worker channel (request ids are unique within a channel). */
export function createPortResponder(host: ProcessHost, options?: PortResponderOptions): PortResponder {
  const streaming = new Map<number, () => void>();
  return {
    async serve(request, post) {
      const { reqId } = request;
      let opened: OpenedPortResponse;
      try {
        opened = await openPortResponse(host, request, options);
      } catch (error) {
        return post({ type: 'response', reqId, status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE }, body: String(error instanceof Error ? error.message : error) }, []);
      }
      post({ type: 'response', reqId, status: opened.status, headers: opened.headers, body: null, streaming: true }, []);
      streaming.set(
        reqId,
        drainBody(opened.body, {
          chunk(data) {
            const buffer = transferable(data);
            post({ type: 'chunk', reqId, data: buffer }, [buffer]);
          },
          end(error) {
            streaming.delete(reqId);
            post(error ? { type: 'end', reqId, error } : { type: 'end', reqId }, []);
          },
        }),
      );
    },
    cancel(reqId) {
      streaming.get(reqId)?.();
      streaming.delete(reqId);
    },
    dispose() {
      for (const stop of streaming.values()) stop();
      streaming.clear();
    },
  };
}
