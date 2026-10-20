/**
 * The host end of the preview bridge (see core's previewBridge.ts for the page
 * end). A service worker cannot carry a WebSocket or set a cookie, so preview
 * pages ask this page instead, each over a MessagePort they transfer:
 *
 *   • `SOCKET_MESSAGE_TYPE` — connect a WebSocket to the virtual server on a
 *     port. The handshake and frames run over an upgraded connection to the
 *     server (`connectWebSocket` over `ProcessHost.upgrade`), carrying the
 *     preview's cookies for that port; messages relay both ways on the port.
 *   • `COOKIE_MESSAGE_TYPE` — keep a virtual-server page's `document.cookie`
 *     in step with the jar, and store what the page assigns.
 *
 * One window listener per runtime, accepting only messages from the preview
 * origin whose page sits under this runtime's base (as `listenToPreview` does).
 *
 * A page that goes away posts `close` for its sockets (see the page end); a
 * port that can no longer be posted to closes its connection too, so a server
 * socket never outlives the page it served.
 */
import {
  COOKIE_MESSAGE_TYPE,
  SOCKET_MESSAGE_TYPE,
  connectWebSocket,
  parsePortPath,
  type ByteChannel,
  type HttpRequestData,
  type PortCookieJars,
  type WebSocketConnection,
} from '@seanhogg/builderforce-webcontainers-core';
import { previewPageOf } from './previewMessages.js';

export interface PreviewBridgeOptions {
  /** Open an upgraded connection to the server on `port` (`ProcessHost.upgrade`). */
  upgrade(port: number, request: HttpRequestData): ByteChannel | undefined;
  /** The runtime's cookie jars: sent with WebSocket handshakes and mirrored into `document.cookie`. */
  cookies?: PortCookieJars;
  /** The runtime's nonce: pages must carry it (see `previewPageOf`). */
  nonce?: string;
}

/** The slice of MessagePort the bridge uses. */
export interface BridgePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface PreviewBridge {
  /** WebSockets currently open through the bridge. */
  readonly openSockets: number;
  dispose(): void;
}

/** Pages kept in sync per server port; older ones (navigated away, never said so) are dropped past this. */
const COOKIE_PAGES_PER_PORT = 50;

interface BridgeMessage {
  type?: unknown;
  href?: unknown;
  port?: unknown;
  path?: unknown;
  protocols?: unknown;
}

export function listenToPreviewBridge(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  origin: string,
  base: string,
  options: PreviewBridgeOptions,
): PreviewBridge {
  const sockets = new Set<WebSocketConnection>();
  const cookiePages = new Map<number, Array<{ port: BridgePort; path: string }>>();

  function openSocket(channel: BridgePort, data: BridgeMessage, page: URL): void {
    const port = Number(data.port);
    const path = typeof data.path === 'string' && data.path.startsWith('/') ? data.path : undefined;
    const protocols = Array.isArray(data.protocols) ? data.protocols.filter((p): p is string => typeof p === 'string') : [];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !path) {
      channel.postMessage({ kind: 'close', code: 1006, reason: '', wasClean: false });
      return channel.close();
    }
    const headers: Record<string, string> = { host: `localhost:${port}`, origin: page.origin };
    const cookie = options.cookies?.jar(port).header(path);
    if (cookie) headers.cookie = cookie;
    if (typeof navigator !== 'undefined' && navigator.userAgent) headers['user-agent'] = navigator.userAgent;
    const connection = connectWebSocket((request) => options.upgrade(port, request), { path, protocols, headers });
    sockets.add(connection);
    /** Post to the page; a port that throws (the page is gone) ends the connection. */
    let pageGone = false;
    const toPage = (message: unknown, transfer?: Transferable[]): void => {
      if (pageGone) return;
      try {
        channel.postMessage(message, transfer);
      } catch {
        // Posting failed: the page (and its port) is gone. Hang up on the server for it.
        pageGone = true;
        sockets.delete(connection);
        channel.close();
        connection.close(1001, 'The preview page is gone.');
      }
    };
    connection.onOpen(({ protocol }) => toPage({ kind: 'open', protocol }));
    connection.onMessage((message) => {
      if (typeof message === 'string') return toPage({ kind: 'message', data: message });
      const buffer = new Uint8Array(message).buffer as ArrayBuffer;
      toPage({ kind: 'message', data: buffer }, [buffer]);
    });
    connection.onClose((info) => {
      sockets.delete(connection);
      toPage({ kind: 'close', ...info });
      channel.close();
    });
    channel.onmessage = (event) => {
      const message = event.data as { kind?: unknown; data?: unknown; code?: unknown; reason?: unknown } | null;
      if (message?.kind === 'send') {
        if (typeof message.data === 'string') connection.send(message.data);
        else if (message.data instanceof ArrayBuffer) connection.send(new Uint8Array(message.data));
      } else if (message?.kind === 'close') {
        connection.close(typeof message.code === 'number' ? message.code : undefined, typeof message.reason === 'string' ? message.reason : undefined);
      }
    };
  }

  function syncCookies(channel: BridgePort, page: URL): void {
    const cookies = options.cookies;
    const server = parsePortPath(page.pathname.slice(base.length - 1));
    if (!cookies || !server) return channel.close();
    const pages = cookiePages.get(server.port) ?? [];
    pages.push({ port: channel, path: server.path });
    if (pages.length > COOKIE_PAGES_PER_PORT) pages.shift()?.port.close();
    cookiePages.set(server.port, pages);
    channel.onmessage = (event) => {
      const message = event.data as { kind?: unknown; value?: unknown } | null;
      if (message?.kind === 'set-cookie' && typeof message.value === 'string') cookies.jar(server.port).setFromDocument(message.value, server.path);
    };
    // The page started from the jar as it was when served; catch up on anything since.
    channel.postMessage({ kind: 'cookies', value: cookies.jar(server.port).documentCookie(server.path) });
  }

  const stopCookies = options.cookies?.onChange((port) => {
    const jar = options.cookies!.jar(port);
    for (const page of cookiePages.get(port) ?? []) page.port.postMessage({ kind: 'cookies', value: jar.documentCookie(page.path) });
  });

  const onMessage = (event: MessageEvent) => {
    const data = event.data as BridgeMessage | null;
    const channel = event.ports?.[0] as BridgePort | undefined;
    const page = channel && data ? previewPageOf(event, origin, base, options.nonce) : undefined;
    if (!page) return;
    if (data!.type === SOCKET_MESSAGE_TYPE) openSocket(channel!, data!, page);
    else if (data!.type === COOKIE_MESSAGE_TYPE) syncCookies(channel!, page);
  };
  target.addEventListener('message', onMessage as EventListener);

  return {
    get openSockets() {
      return sockets.size;
    },
    dispose() {
      target.removeEventListener('message', onMessage as EventListener);
      stopCookies?.();
      for (const connection of [...sockets]) connection.close(1001, 'The runtime stopped.');
      sockets.clear();
      for (const pages of cookiePages.values()) for (const page of pages) page.port.close();
      cookiePages.clear();
    },
  };
}
