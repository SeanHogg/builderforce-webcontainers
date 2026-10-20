/**
 * Scripts injected into preview pages that let them reach virtual servers the
 * way a page reaches a real one, where a service worker cannot help:
 *
 *   • WebSockets. A service worker never sees a WebSocket, so the page's
 *     `WebSocket` is replaced by one that, for URLs naming a virtual server
 *     (`ws://localhost:3000/…`, `/__bfwc/<id>/__port/3000/…`, or a path on the
 *     page's own host from a page that server served), opens a MessageChannel
 *     to the runtime's host page (`parent`, else `opener`). The host connects
 *     to the server and relays frames both ways. Every other URL gets the real
 *     `WebSocket`, untouched.
 *   • `document.cookie` on pages a virtual server served. The host keeps those
 *     cookies (a service worker cannot set `Set-Cookie`); this mirrors the
 *     non-HttpOnly ones into `document.cookie` and sends assignments back.
 *
 * Messages on a socket's channel — page → host: `{ kind: 'send', data }`,
 * `{ kind: 'close', code, reason }`; host → page: `{ kind: 'open', protocol }`,
 * `{ kind: 'message', data }` (string or ArrayBuffer), `{ kind: 'close', code, reason, wasClean }`.
 * On the cookie channel — page → host `{ kind: 'set-cookie', value }`, host → page `{ kind: 'cookies', value }`.
 *
 * A MessagePort gives no signal when the page on the other end goes away, so
 * the page says so: on `pagehide`, and when it gives up waiting for the host
 * (the connect timeout), it posts `{ kind: 'close', code: 1001 }` for every
 * socket still open — otherwise the server's end (an HMR socket) would leak on
 * every reload.
 *
 * Every message to the host carries the runtime's `nonce` (when it has one):
 * the host accepts a page's messages only with it, so a frame on the preview
 * origin cannot pass itself off as another runtime's page by its `href` alone.
 */

/** page → host, with a MessagePort: "connect a WebSocket to `port` at `path`". */
export const SOCKET_MESSAGE_TYPE = 'bfwc:socket';
/** page → host, with a MessagePort: "keep my `document.cookie` in sync" (pages served by a virtual server). */
export const COOKIE_MESSAGE_TYPE = 'bfwc:cookies';
/** How long a page waits for the host to answer a socket before failing it (code 1006). */
export const SOCKET_CONNECT_TIMEOUT_MS = 15_000;

/** `JSON.stringify`, safe inside an inline script. */
export const scriptLiteral = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The `WebSocket` replacement; runs in every preview page (dev-server documents and virtual-server HTML). `nonce`: the runtime's (see the module doc). */
export function previewSocketScript(nonce = ''): string {
  return `<script>(function(){
  var Native = window.WebSocket;
  if (!Native || Native.__bfwc) return;
  var runtime = window.parent !== window ? window.parent : window.opener;
  var m = /^(.*\\/__bfwc\\/[A-Za-z0-9_-]+\\/)(?:__port\\/(\\d{1,5})(?:\\/|$))?/.exec(location.pathname);
  if (!runtime || !m || typeof MessageChannel === 'undefined') return;
  var base = m[1], ownPort = m[2] ? Number(m[2]) : 0;
  var LOCAL = /^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])$/i;
  function target(url) {
    var u;
    try { u = new URL(String(url), location.href); } catch (_) { return null; }
    if (!/^(wss?|https?):$/.test(u.protocol)) return null;
    if (u.host === location.host) {
      if (u.pathname.indexOf(base) === 0) {
        var p = /^__port\\/(\\d{1,5})(\\/.*)?$/.exec(u.pathname.slice(base.length));
        return p ? { port: Number(p[1]), path: (p[2] || '/') + u.search } : null;
      }
      return ownPort ? { port: ownPort, path: u.pathname + u.search } : null;
    }
    if (LOCAL.test(u.hostname)) return { port: Number(u.port || (/^(wss|https):$/.test(u.protocol) ? 443 : 80)), path: u.pathname + u.search };
    return null;
  }
  var CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
  var live = new Set();
  window.addEventListener('pagehide', function () {
    live.forEach(function (s) { s._abandon(); });
  });
  class VirtualWebSocket extends EventTarget {
    constructor(url, protocols) {
      var t = target(url);
      if (!t) return protocols === undefined ? new Native(url) : new Native(url, protocols);
      super();
      var self = this, channel = new MessageChannel();
      this._url = new URL(String(url), location.href).href.replace(/^http/, 'ws');
      this._state = CONNECTING;
      this._protocol = '';
      this._binaryType = 'blob';
      this._queue = Promise.resolve();
      this._port = channel.port1;
      this._port.onmessage = function (e) { self._receive(e.data); };
      this._timer = setTimeout(function () { self._abandon(); }, ${SOCKET_CONNECT_TIMEOUT_MS});
      live.add(this);
      var list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : Array.from(protocols, String);
      runtime.postMessage({ type: ${JSON.stringify(SOCKET_MESSAGE_TYPE)}, href: location.href, nonce: ${scriptLiteral(nonce)}, port: t.port, path: t.path, protocols: list }, '*', [channel.port2]);
    }
    get url() { return this._url; }
    get readyState() { return this._state; }
    get protocol() { return this._protocol; }
    get extensions() { return ''; }
    get bufferedAmount() { return 0; }
    get binaryType() { return this._binaryType; }
    set binaryType(v) { if (v === 'blob' || v === 'arraybuffer') this._binaryType = v; }
    send(data) {
      if (this._state === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      if (this._state !== OPEN) return;
      var port = this._port;
      var value = typeof data === 'string' ? data
        : data instanceof Blob ? data.arrayBuffer()
        : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data instanceof ArrayBuffer ? data.slice(0) : String(data);
      this._queue = this._queue.then(function () { return value; }).then(function (v) { port.postMessage({ kind: 'send', data: v }); });
    }
    close(code, reason) {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999.", 'InvalidAccessError');
      if (this._state === CLOSING || this._state === CLOSED) return;
      this._state = CLOSING;
      var port = this._port;
      this._queue.then(function () { port.postMessage({ kind: 'close', code: code, reason: reason === undefined ? '' : String(reason) }); });
    }
    /** Tell the host this end is gone (it would never know otherwise), then close here. */
    _abandon() {
      if (this._state === CLOSED) return;
      this._port.postMessage({ kind: 'close', code: 1001, reason: '' });
      this._receive({ kind: 'close', code: 1006, reason: '', wasClean: false });
    }
    _receive(m) {
      if (!m || this._state === CLOSED) return;
      if (m.kind === 'open' && this._state === CONNECTING) {
        clearTimeout(this._timer);
        this._state = OPEN;
        this._protocol = m.protocol || '';
        this._emit(new Event('open'));
      } else if (m.kind === 'message' && this._state !== CONNECTING) {
        var d = m.data;
        if (typeof d !== 'string' && this._binaryType === 'blob') d = new Blob([d]);
        this._emit(new MessageEvent('message', { data: d, origin: new URL(this._url).origin }));
      } else if (m.kind === 'close') {
        clearTimeout(this._timer);
        this._state = CLOSED;
        live.delete(this);
        this._port.close();
        if (!m.wasClean) this._emit(new Event('error'));
        this._emit(new CloseEvent('close', { code: m.code, reason: m.reason || '', wasClean: !!m.wasClean }));
      }
    }
    _emit(event) {
      var handler = this['on' + event.type];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }
  }
  [['CONNECTING', CONNECTING], ['OPEN', OPEN], ['CLOSING', CLOSING], ['CLOSED', CLOSED]].forEach(function (c) {
    Object.defineProperty(VirtualWebSocket, c[0], { value: c[1] });
    Object.defineProperty(VirtualWebSocket.prototype, c[0], { value: c[1] });
  });
  Object.defineProperty(VirtualWebSocket, Symbol.hasInstance, { value: function (o) { return o instanceof Native || Function.prototype[Symbol.hasInstance].call(VirtualWebSocket, o); } });
  VirtualWebSocket.__bfwc = true;
  window.WebSocket = VirtualWebSocket;
})();</script>`;
}

/**
 * `document.cookie` for a page a virtual server served: starts from the host's
 * jar (`initial`: the non-HttpOnly cookies for this page's path), stays in sync
 * over a channel, and sends assignments to the host's jar.
 */
export function previewCookieScript(initial: string, nonce = ''): string {
  return `<script>(function(){
  var runtime = window.parent !== window ? window.parent : window.opener;
  var cookies = ${scriptLiteral(initial)};
  var port = null;
  if (runtime && typeof MessageChannel !== 'undefined') {
    var channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = function (e) { if (e.data && e.data.kind === 'cookies') cookies = String(e.data.value); };
    runtime.postMessage({ type: ${JSON.stringify(COOKIE_MESSAGE_TYPE)}, href: location.href, nonce: ${scriptLiteral(nonce)} }, '*', [channel.port2]);
  }
  function apply(value) {
    var parts = value.split(';'), pair = parts[0], eq = pair.indexOf('=');
    if (eq < 0) return;
    var name = pair.slice(0, eq).trim(), remove = false;
    if (!name) return;
    for (var i = 1; i < parts.length; i++) {
      var a = parts[i].trim(), k = a.split('=')[0].trim().toLowerCase(), v = a.slice(a.indexOf('=') + 1).trim();
      if (k === 'httponly') return;
      if (k === 'max-age' && /^-?\\d+$/.test(v) && Number(v) <= 0) remove = true;
      if (k === 'expires' && Date.parse(v) <= Date.now()) remove = true;
    }
    var list = cookies ? cookies.split('; ').filter(function (c) { return c.slice(0, c.indexOf('=')) !== name; }) : [];
    if (!remove) list.push(name + '=' + pair.slice(eq + 1).trim());
    cookies = list.join('; ');
  }
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () { return cookies; },
      set: function (value) { value = String(value); apply(value); if (port) port.postMessage({ kind: 'set-cookie', value: value }); },
    });
  } catch (_) {}
})();</script>`;
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /<!doctype[^>]*>/i;
/** Content past which `<head>` can no longer appear. */
const BODY_STARTED = /<(?:body|script|link|meta|style|title|div|p)[\s>/]/i;

/**
 * Where to inject the bridge into a streamed document, from its first bytes:
 * just after `<head …>`, else after `<html …>` or the doctype (never before the
 * doctype, which would switch the page to quirks mode), else the start.
 * Undefined while the prefix is too short to tell; pass `complete` at the end of the body.
 */
export function bridgeInsertionPoint(prefix: string, complete = false): number | undefined {
  const head = HEAD_OPEN.exec(prefix);
  if (head) return head.index + head[0].length;
  if (!complete && !BODY_STARTED.test(prefix) && prefix.length < 4096) return undefined;
  const html = HTML_OPEN.exec(prefix);
  if (html) return html.index + html[0].length;
  const doctype = DOCTYPE.exec(prefix);
  return doctype ? doctype.index + doctype[0].length : 0;
}
