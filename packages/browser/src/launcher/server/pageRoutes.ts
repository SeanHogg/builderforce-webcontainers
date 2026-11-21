/**
 * The host page's origin (`localhost:<port>`): the launcher page and its files,
 * the process Worker database Workers start from (always on the host origin, never
 * a preview origin), and the `/__bf/*` API — every endpoint of which needs the
 * per-launch token in {@link LAUNCH_TOKEN_HEADER}.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LauncherLabels } from '../labels.js';
import { LAUNCH_PATHS, LAUNCH_TOKEN_HEADER, PAGE_ASSET_PREFIX, PREVIEW_PAGE_PATH, PREVIEW_PROBE_PATH, PREVIEW_SCRIPT_PREFIX, type LaunchInfo, type ProjectChange, type ProjectSnapshot } from '../protocol.js';
import type { LauncherHosts } from './hosts.js';
import { send, sendText } from './httpResponses.js';
import { PAGE_FILES, type LauncherAssets } from './launcherAssets.js';
import { apiHeaders, pageHeaders, workerScriptHeaders } from './previewHeaders.js';
import { previewPageAllowed, previewPageHtml, previewPageTarget } from './previewPage.js';
import type { ProjectWatch } from './projectWatch.js';

export interface PageRouteContext {
  hosts: LauncherHosts;
  assets: LauncherAssets;
  token: string;
  launchInfo(): Promise<LaunchInfo>;
  files(): Promise<ProjectSnapshot>;
  watch: ProjectWatch;
  /** Every open `/__bf/changes` stream, so `close()` can end them. */
  streams: Set<ServerResponse>;
  /** The `/preview` page's text. */
  labels: LauncherLabels;
  /** Checks the preview origin's redirect ticket. */
  previewSecret: Uint8Array;
}

/** How often an idle change stream sends a comment, so proxies and the page see it is alive. */
const HEARTBEAT_MS = 15_000;

function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function serveChanges(req: IncomingMessage, res: ServerResponse, context: PageRouteContext): void {
  res.writeHead(200, { ...apiHeaders('text/event-stream; charset=utf-8'), Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const emit = (event: string | undefined, data: unknown) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = context.watch.subscribe({
    changes: (changes: ProjectChange[]) => {
      for (const change of changes) emit(undefined, change);
    },
    error: (message) => emit('error', { message }),
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  context.streams.add(res);
  const end = () => {
    clearInterval(heartbeat);
    unsubscribe();
    context.streams.delete(res);
  };
  req.on('close', end);
  res.on('close', end);
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, context: PageRouteContext): Promise<void> {
  if (!tokenMatches(req.headers[LAUNCH_TOKEN_HEADER], context.token)) {
    sendText(req, res, 403, apiHeaders('text/plain; charset=utf-8'), 'The launch token is missing or wrong.');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, { ...apiHeaders('text/plain; charset=utf-8'), Allow: 'GET, HEAD' }, 'Method not allowed.');
    return;
  }
  switch (url.pathname) {
    case LAUNCH_PATHS.launch:
      return send(req, res, 200, apiHeaders('application/json; charset=utf-8'), JSON.stringify(await context.launchInfo()));
    case LAUNCH_PATHS.files:
      return send(req, res, 200, apiHeaders('application/json; charset=utf-8'), JSON.stringify(await context.files()));
    case LAUNCH_PATHS.changes:
      return serveChanges(req, res, context);
    default:
      return sendText(req, res, 404, apiHeaders('text/plain; charset=utf-8'), 'Not found.');
  }
}

export async function servePageOrigin(req: IncomingMessage, res: ServerResponse, url: URL, context: PageRouteContext): Promise<void> {
  if (url.pathname.startsWith('/__bf/')) return serveApi(req, res, url, context);
  const { hosts, assets } = context;
  const appOrigins = hosts.appOriginTemplate.replace('{key}', '*');
  const probes = [`${hosts.relayOrigin}${PREVIEW_PROBE_PATH}`, `${appOrigins}${PREVIEW_PROBE_PATH}`];
  const headersFor = (contentType: string) => pageHeaders(contentType, hosts.relayOrigin, appOrigins, probes);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, { ...headersFor('text/plain; charset=utf-8'), Allow: 'GET, HEAD' }, 'Method not allowed.');
    return;
  }
  // No script on the host origin may become a service worker.
  if (req.headers['service-worker'] !== undefined) return sendText(req, res, 403, headersFor('text/plain; charset=utf-8'), 'Not a service worker.');
  if (url.pathname === '/' || url.pathname === '/index.html') return send(req, res, 200, headersFor(PAGE_FILES['index.html']!), assets.page['index.html']);
  // A preview in its own tab, framed under this origin so the relay's service worker serves it (previewPage.ts).
  if (url.pathname === PREVIEW_PAGE_PATH) {
    const src = previewPageTarget(url, hosts);
    if (!src) return sendText(req, res, 400, headersFor('text/plain; charset=utf-8'), context.labels.previewInvalid);
    // Only the user or the launcher page opens it; another site's link gets nothing framed (previewPage.ts).
    if (!previewPageAllowed(url, req.headers['sec-fetch-site'], context.previewSecret, src)) {
      return sendText(req, res, 403, headersFor('text/plain; charset=utf-8'), context.labels.previewInvalid);
    }
    return send(req, res, 200, headersFor('text/html; charset=utf-8'), previewPageHtml(src, context.labels));
  }
  if (url.pathname.startsWith(PAGE_ASSET_PREFIX)) {
    const name = url.pathname.slice(PAGE_ASSET_PREFIX.length);
    const type = Object.hasOwn(PAGE_FILES, name) ? PAGE_FILES[name] : undefined;
    if (type && name !== 'index.html') return send(req, res, 200, headersFor(type), assets.page[name]);
  }
  if (url.pathname === `${PREVIEW_SCRIPT_PREFIX}process-worker.js`) return send(req, res, 200, workerScriptHeaders(), assets.scripts['process-worker.js']);
  sendText(req, res, 404, headersFor('text/plain; charset=utf-8'), 'Not found.');
}
