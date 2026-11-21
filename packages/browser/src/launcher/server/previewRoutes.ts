/**
 * The preview origins' answers — the relay's (`127.0.0.1:<port>`) and each
 * application's (`<key>.localhost:<port>`): the relay page, `sw.js` and the
 * process Workers under `/__bfwc/`, the .NET bundle under `/dotnet/`, a preview
 * path no service worker answered (`previewPage.ts`: a tab is redirected to the host
 * page's `/preview`, a frame gets the bootstrap), and a 404 (with the preview
 * document policy) for anything else. Routed the way the
 * Builderforce API routes its preview hosts (`browserPreviewOrigin.ts`): a script
 * is registered as a service worker only as `sw.js`, and only in relay mode.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LauncherLabels } from '../labels.js';
import { DOTNET_BUNDLE_PREFIX, isPreviewPath, PREVIEW_PROBE_PATH, PREVIEW_SCRIPT_PREFIX, previewPageHref } from '../protocol.js';
import { readDotnetBundleFile } from './dotnetBundle.js';
import type { LauncherHosts } from './hosts.js';
import { send, sendText } from './httpResponses.js';
import type { LauncherAssets } from './launcherAssets.js';
import {
  PREVIEW_WORKER_SCRIPTS, previewDocumentHeaders, probeHeaders, relayHeaders, serviceWorkerAllowed, serviceWorkerHeaders, workerScriptHeaders, type PreviewScript,
} from './previewHeaders.js';
import { mintPreviewTicket, previewBootstrapHeaders, previewBootstrapHtml } from './previewPage.js';

/** Header a preview page must send to POST a load report. */
export const REPORT_TOKEN_HEADER = 'x-bfwc-report-token';

export interface PreviewRouteContext {
  hosts: LauncherHosts;
  assets: LauncherAssets;
  /** The .NET bundle's directory, when there is one. */
  dotnetDir: string | null;
  /** When set, `POST /__bfwc/report` is accepted with this token. Otherwise the path is a 404. */
  reportToken?: string;
  /** The bootstrap page's text. */
  labels: LauncherLabels;
  /** Signs the redirect's `/preview` ticket (per launch, never sent anywhere). */
  previewSecret: Uint8Array;
}

function scriptOf(pathname: string): PreviewScript | 'relay.html' | null {
  if (!pathname.startsWith(PREVIEW_SCRIPT_PREFIX)) return null;
  const name = pathname.slice(PREVIEW_SCRIPT_PREFIX.length);
  if (name === 'relay.html') return name;
  return (PREVIEW_WORKER_SCRIPTS as readonly string[]).includes(name) ? (name as PreviewScript) : null;
}

/** Path-scoped loopback sources the .NET Worker loads its bundle from: its own origin's and the relay's `/dotnet/`. */
function dotnetSources(host: string, hosts: LauncherHosts): string[] {
  return [...new Set([`${hosts.scheme}://${host}${DOTNET_BUNDLE_PREFIX}`, `${hosts.relayOrigin}${DOTNET_BUNDLE_PREFIX}`])];
}

/** CORS for the .NET bundle: only the launcher's own preview origins (the relay, an application's) may read it cross-origin — never `*`. */
function bundleCors(origin: string | string[] | undefined, hosts: LauncherHosts): Record<string, string> {
  const named = typeof origin === 'string' ? hosts.classifyOrigin(origin) : null;
  const allowed = named !== null && named.kind !== 'page';
  return allowed ? { 'Access-Control-Allow-Origin': origin as string, Vary: 'Origin' } : { Vary: 'Origin' };
}

function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  return typeof presented === 'string' && presented.length === token.length && presented === token;
}

export async function servePreviewOrigin(req: IncomingMessage, res: ServerResponse, url: URL, host: string, context: PreviewRouteContext): Promise<void> {
  const frameAncestors = [context.hosts.pageOrigin];
  const documentHeaders = previewDocumentHeaders(host, frameAncestors);
  if (url.pathname === '/__bfwc/report') {
    if (!context.reportToken) return sendText(req, res, 404, documentHeaders, 'Not found.');
    if (req.method !== 'POST') return sendText(req, res, 405, { ...documentHeaders, Allow: 'POST' }, 'Method not allowed.');
    if (!tokenMatches(req.headers[REPORT_TOKEN_HEADER], context.reportToken)) {
      return sendText(req, res, 403, documentHeaders, 'The report token is missing or wrong.');
    }
    return send(req, res, 204, documentHeaders);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, { ...documentHeaders, Allow: 'GET, HEAD' }, 'Method not allowed.');
    return;
  }

  // The host page's reachability probe (the origin resolves and its certificate is trusted).
  if (url.pathname === PREVIEW_PROBE_PATH) return send(req, res, 204, probeHeaders(context.hosts.pageOrigin));

  const script = scriptOf(url.pathname);
  if (script) {
    const refused = () => sendText(req, res, 403, { ...documentHeaders, 'Cache-Control': 'no-store' }, 'This preview configuration is not granted.');
    // A service worker registration names its script in this header: only the relay's `sw.js` may be one.
    if (req.headers['service-worker'] !== undefined && script !== 'sw.js') return refused();
    if (script === 'relay.html') return send(req, res, 200, relayHeaders(frameAncestors), context.assets.relayHtml);
    if (script === 'sw.js') {
      if (!serviceWorkerAllowed(url)) return refused();
      return send(req, res, 200, serviceWorkerHeaders(), context.assets.scripts['sw.js']);
    }
    const ownPaths = script === 'dotnet-worker.js' && context.dotnetDir ? dotnetSources(host, context.hosts) : [];
    return send(req, res, 200, workerScriptHeaders(ownPaths), context.assets.scripts[script]);
  }

  if (url.pathname.startsWith(DOTNET_BUNDLE_PREFIX) && context.dotnetDir) {
    let relativePath = '';
    try {
      relativePath = decodeURIComponent(url.pathname.slice(DOTNET_BUNDLE_PREFIX.length));
    } catch {
      // A malformed escape names no file: the 404 below.
    }
    const file = relativePath ? await readDotnetBundleFile(context.dotnetDir, relativePath) : null;
    if (file) {
      // Immutable bytes: an application's Worker on its own origin reads them from the relay's.
      return send(req, res, 200, { ...documentHeaders, 'Content-Type': file.contentType, 'Cache-Control': 'public, max-age=3600', ...bundleCors(req.headers.origin, context.hosts) }, file.body);
    }
  }
  // A preview path no service worker answered (previewPage.ts): a tab the user opened goes to the host page's `/preview`, a frame waits for the worker.
  if (isPreviewPath(url.pathname)) {
    const destination = req.headers['sec-fetch-dest'];
    if (destination === 'document' && req.headers['sec-fetch-site'] === 'none') {
      const location = `${context.hosts.pageOrigin}${previewPageHref(url.href, mintPreviewTicket(context.previewSecret, url.href))}`;
      return send(req, res, 302, { ...documentHeaders, 'Cache-Control': 'no-store', Location: location });
    }
    if (destination === 'iframe' || destination === 'frame') return send(req, res, 503, previewBootstrapHeaders(frameAncestors), previewBootstrapHtml(context.labels));
  }
  sendText(req, res, 404, documentHeaders, 'Not found.');
}
