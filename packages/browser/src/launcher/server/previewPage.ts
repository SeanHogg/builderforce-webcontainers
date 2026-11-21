/**
 * A preview in its own tab, and a preview frame no service worker answered.
 *
 * Every preview origin (`127.0.0.1:<port>`, `<key>.localhost:<port>`) is a different
 * SITE from the host page (`localhost:<port>`), so the relay's service worker is
 * registered in the host page's third-party storage partition: it serves preview
 * frames on the host page, and nothing else. A top-level tab on a preview URL ("Open
 * in new tab", the `Local:` URL a dev server prints) is the preview origin's FIRST-party
 * partition, where no service worker exists — the request reached this server, which
 * answered "Not found.".
 *
 * - A top-level navigation the USER started (`Sec-Fetch-Site: none`) to a preview path
 *   is redirected to the host page's `/preview?src=<url>&ticket=<…>` (`previewPageHtml`),
 *   which frames the same URL full size: under the host page's site again, so the relay's
 *   worker — and the launcher tab's runtime behind it — serves it. The page holds no
 *   token, runs no script, and frames only this launcher's preview origins (its CSP
 *   `frame-src`, and the check here). It answers only the user and the launcher page
 *   (`previewPageAllowed`): before it, no other site could make the runtime serve a
 *   request (only the token-holding launcher page framed previews in that partition),
 *   and a cross-site link to `/preview` or to a preview URL must not change that.
 * - A FRAMED preview path that reached the server is a frame the worker does not
 *   control yet (it loaded before the relay's worker activated, or a restarted browser
 *   has not re-registered it): the bootstrap page waits for the worker and reloads
 *   once it is active, or says the preview is not running.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { LauncherLabels } from '../labels.js';
import { isPreviewPath, PREVIEW_PAGE_PARAM, PREVIEW_PAGE_TICKET } from '../protocol.js';
import type { LauncherHosts } from './hosts.js';
import type { HeaderSet } from './previewHeaders.js';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The preview URL `/preview?src=` names, when it is one of this launcher's previews
 * (the relay's or an application's origin, a preview path, no credentials); else null.
 */
export function previewPageTarget(url: URL, hosts: LauncherHosts): string | null {
  const src = url.searchParams.getAll(PREVIEW_PAGE_PARAM);
  if (src.length !== 1) return null;
  let target: URL;
  try {
    target = new URL(src[0]!);
  } catch {
    return null;
  }
  const origin = hosts.classifyOrigin(target.origin);
  if (!origin || origin.kind === 'page' || target.username || target.password || !isPreviewPath(target.pathname)) return null;
  return target.href;
}

/** How long a redirect's ticket opens `/preview`: one navigation's worth. */
export const PREVIEW_TICKET_TTL_MS = 60_000;

const ticketMac = (secret: Uint8Array, expires: number, src: string) => createHmac('sha256', secret).update(`${expires}\n${src}`).digest('base64url');

/** A ticket for `src`: `<expiry ms>.<HMAC(secret, expiry, src)>`. Minted only by the redirect of a user-started tab. */
export function mintPreviewTicket(secret: Uint8Array, src: string, now: number = Date.now()): string {
  const expires = now + PREVIEW_TICKET_TTL_MS;
  return `${expires}.${ticketMac(secret, expires, src)}`;
}

/** Whether `ticket` was minted for `src` with `secret` and has not expired. */
export function previewTicketValid(secret: Uint8Array, src: string, ticket: string, now: number = Date.now()): boolean {
  const dot = ticket.indexOf('.');
  const expires = Number(ticket.slice(0, dot));
  if (dot < 1 || !Number.isSafeInteger(expires) || expires < now || expires > now + PREVIEW_TICKET_TTL_MS) return false;
  const presented = Buffer.from(ticket.slice(dot + 1), 'utf8');
  const expected = Buffer.from(ticketMac(secret, expires, src), 'utf8');
  return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

/** Fetch Metadata of a navigation the user started (typed, bookmarked, opened from a terminal) or the page itself made. */
export const userNavigation = (site: string | string[] | undefined) => site === 'none' || site === 'same-origin';

/**
 * Whether `/preview` may frame `src` for this request: a navigation the user or the
 * launcher page started, or one carrying a fresh ticket the preview origin's redirect
 * minted. Another site linking here gets neither, so it cannot make the running
 * runtime serve a request of its choosing.
 */
export function previewPageAllowed(url: URL, site: string | string[] | undefined, secret: Uint8Array, src: string, now: number = Date.now()): boolean {
  if (userNavigation(site)) return true;
  const tickets = url.searchParams.getAll(PREVIEW_PAGE_TICKET);
  return tickets.length === 1 && previewTicketValid(secret, src, tickets[0]!, now);
}

/** The host page's `/preview` document: `src` framed full size (no script; the page's CSP allows only preview origins in `frame-src`). */
export function previewPageHtml(src: string, labels: LauncherLabels): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="light dark" />',
    `<title>${escapeHtml(labels.preview)}</title>`,
    '<link rel="stylesheet" href="/launcher/launcher.css" />',
    '</head>',
    '<body class="bf-preview-page">',
    `<iframe class="bf-preview-page-frame" src="${escapeHtml(src)}" title="${escapeHtml(labels.preview)}"></iframe>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The bootstrap's script: wait (up to ~15s) for the preview worker registered for this
 * page to be active, then reload — into its control. A reload that came back here
 * within 10s (`history.state`, which survives the reload) is not retried (no loop):
 * the preview is not running.
 */
const BOOTSTRAP_SCRIPT = `(function () {
  var show = function (id) {
    document.getElementById('bfwc-starting').hidden = id !== 'bfwc-starting';
    document.getElementById('bfwc-not-running').hidden = id !== 'bfwc-not-running';
  };
  var last = (history.state && history.state.bfwcBootstrap) || 0;
  if (!navigator.serviceWorker || Date.now() - last < 10000) return show('bfwc-not-running');
  var tries = 0;
  var check = function () {
    navigator.serviceWorker.getRegistration(location.href).then(function (registration) {
      if (registration && registration.active) {
        history.replaceState({ bfwcBootstrap: Date.now() }, '');
        location.reload();
      } else if (++tries < 30) {
        setTimeout(check, 500);
      } else {
        show('bfwc-not-running');
      }
    }, function () { show('bfwc-not-running'); });
  };
  check();
})();`;

const BOOTSTRAP_HASH = `'sha256-${createHash('sha256').update(BOOTSTRAP_SCRIPT, 'utf8').digest('base64')}'`;

/** The bootstrap page a framed, uncontrolled preview path gets. */
export function previewBootstrapHtml(labels: LauncherLabels): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8" /><meta name="color-scheme" content="light dark" /></head>',
    '<body>',
    `<p id="bfwc-starting">${escapeHtml(labels.previewStarting)}</p>`,
    `<p id="bfwc-not-running" hidden>${escapeHtml(labels.previewNotRunning)}</p>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** The bootstrap page's headers: its one script by hash, nothing else loads, framed only by the host page, never cached. */
export function previewBootstrapHeaders(frameAncestors: readonly string[]): HeaderSet {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src ${BOOTSTRAP_HASH}`,
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors.join(' ')}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
