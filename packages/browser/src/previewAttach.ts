/**
 * Serving one preview id over one transport: the MessageChannel the service
 * worker forwards requests on, re-attached whenever the worker asks (it was
 * restarted and lost its ports).
 *
 * Every attach carries a fresh nonce chained to the last one the worker
 * ACKNOWLEDGED (`AttachProof`, `WireAttached`; W10 control 2): the worker binds
 * the nonce to the relay client and accepts the next attach of the id from that
 * client only with it. The chain advances only on the worker's acknowledgement,
 * so an attach that never arrived leaves it where the worker is; if the two
 * still part, the worker asks for a fresh attach (`stale_nonce` recovery).
 * Nonces go only through `transport.attach` (postMessage to the exact relay
 * origin), never into a URL. An attach carries no egress: that is host-side
 * configuration of the worker (`relayConfig`).
 *
 * What a channel serves is decided here, on the page, for every request: on an
 * application's own origin only that application's ports (never the dev server,
 * which serves the whole project); on the shared origin the dev server and the
 * workspace's ports (see `PreviewOrigins.mayServe`).
 */
import { parsePortPath, type DevServer, type PortCookieJars } from '@seanhogg/builderforce-webcontainers-core';
import { isPortPath, isWireAttached, isWireCancel, isWireRequest, randomNonce, type WireReply, type WireResponse } from './protocol.js';
import { createPortResponder, type ProcessHost } from './node/index.js';
import type { PreviewTransport } from './transport.js';

export function toWire(reqId: number, served: Awaited<ReturnType<DevServer['handle']>>): { message: WireResponse; transfer: Transferable[] } {
  if (typeof served.body === 'string') {
    return { message: { type: 'response', reqId, status: served.status, headers: served.headers, body: served.body }, transfer: [] };
  }
  const body = served.body.slice().buffer as ArrayBuffer; // a copy: transferring must not detach the VFS's own bytes
  return { message: { type: 'response', reqId, status: served.status, headers: served.headers, body }, transfer: [body] };
}

const FORBIDDEN = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

export interface PreviewAttachOptions {
  transport: PreviewTransport;
  id: string;
  /** The dev server, when this origin serves it (the shared origin only). */
  server?: DevServer;
  processes: ProcessHost;
  cookies: PortCookieJars;
  scripts: () => readonly string[];
  /** The runtime's preview-message nonce (the injected bridge's), not an attach nonce. */
  bridgeNonce: string;
  /** Whether a request through this transport may reach `port` (its owner's origin). */
  mayServePort(port: number): boolean;
  /** A request was refused here (telemetry). */
  onRefused?(port: number | undefined): void;
}

/** Attach `id` on `transport` now and on every re-attach request; returns what stops it. */
export function attachPreview(options: PreviewAttachOptions): () => void {
  const { transport, id, processes } = options;
  let responder: ReturnType<typeof createPortResponder> | undefined;
  /** The nonce of the last attach the worker acknowledged. */
  let previous: string | undefined;
  /** The channel of the latest attach: only its acknowledgement advances the chain. */
  let current: MessageChannel | undefined;

  const refuse = (reqId: number, reply: (message: WireReply, transfer: Transferable[]) => void, port?: number) => {
    options.onRefused?.(port);
    reply({ type: 'response', reqId, status: 403, headers: FORBIDDEN, body: 'This preview origin may not reach that server.' }, []);
  };

  const attach = () => {
    const channel = new MessageChannel();
    const nonce = randomNonce();
    current = channel;
    const reply = (message: WireReply, transfer: Transferable[]) => channel.port1.postMessage(message, transfer);
    // Virtual servers' responses stream (one responder per channel: request ids are per worker).
    responder?.dispose();
    const ports = (responder = createPortResponder(processes, { cookies: options.cookies, scripts: options.scripts, nonce: options.bridgeNonce }));
    channel.port1.onmessage = async (event) => {
      if (isWireAttached(event.data)) {
        if (channel === current && event.data.nonce === nonce) previous = nonce;
        return;
      }
      if (isWireCancel(event.data)) return ports.cancel(event.data.reqId);
      if (!isWireRequest(event.data)) return;
      const request = event.data;
      if (isPortPath(request.path)) {
        const port = parsePortPath(request.path)?.port;
        if (port === undefined || !options.mayServePort(port)) return refuse(request.reqId, reply, port);
        return ports.serve(request, reply);
      }
      if (!options.server) return refuse(request.reqId, reply);
      const { message, transfer } = toWire(request.reqId, await options.server.handle(request.path, request.search));
      reply(message, transfer);
    };
    transport.attach(id, channel.port2, previous === undefined ? { nonce } : { nonce, previous });
  };

  attach();
  const stopReattach = transport.onReattach((wanted) => {
    if (wanted === id) attach();
  });
  return () => {
    stopReattach();
    responder?.dispose();
    responder = undefined;
  };
}
