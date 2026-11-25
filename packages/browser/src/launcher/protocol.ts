/**
 * The local launcher's wire contract (make.md › PRD 31 §4 W11, "Local launch from
 * the VSIX"): what the Node server (`./launcher/server`) answers and what the
 * launcher page (`dist/launcher/page.js`) reads. Pure types and constants, shared
 * by both sides, so neither spells a path or a header twice.
 */
import { PREVIEW_ID } from '../protocol.js';
import type { LauncherLabels } from './labels.js';

/** The header the page forwards the per-launch token in. Every `/__bf/*` endpoint answers 403 without it. */
export const LAUNCH_TOKEN_HEADER = 'x-bfwc-launch-token';

/** The launch URL's fragment parameter carrying the token (a fragment never reaches a server log or a `Referer`). */
export const LAUNCH_TOKEN_PARAM = 'token';

/** The launcher's API paths, on the host page's origin only. */
export const LAUNCH_PATHS = {
  launch: '/__bf/launch.json',
  files: '/__bf/files',
  changes: '/__bf/changes',
  ai: '/__bf/ai',
} as const;

/** The largest `/__bf/ai` request body the launcher reads (matches the file API's total cap's order, never more). */
export const MAX_AI_REQUEST_BYTES = 32 * 1024 * 1024;

/** `POST /__bf/ai`: the page gateway's request, the process body base64 so the envelope is JSON. Headers never cross. */
export interface AiRelayEnvelope {
  resourceId: string;
  models?: string[];
  stream: boolean;
  /** Base64 of the process's request body. */
  body: string;
}

/** Where the runtime's files are served on every preview origin (the relay's and each application's). */
export const PREVIEW_SCRIPT_PREFIX = '/__bfwc/';

/**
 * The probe every preview origin answers the host page (204, readable by the page's
 * origin only): fetched before booting, it proves the relay and the `*.localhost`
 * application origins resolve and that their certificates are trusted.
 */
export const PREVIEW_PROBE_PATH = '/__bfwc/probe';

/**
 * The preview page on the host page's origin: `/preview?src=<a preview URL>` frames
 * that preview full size. A preview opened in its own tab ("Open in new tab", the
 * `Local:` URL a dev server prints) lands here: framed under the host page's site, it
 * shares the storage partition — and so the service worker — the launcher's relay
 * registered. A top-level tab on the preview origin itself is a different partition
 * with no service worker in it, so the preview origin redirects such a navigation here.
 *
 * Only the user may open it, never another site: it is answered for a navigation the
 * user started (`Sec-Fetch-Site: none`), one from the launcher page itself
 * (`same-origin`), or one carrying a fresh {@link PREVIEW_PAGE_TICKET} the preview
 * origin's redirect minted (a redirect from another origin reads `cross-site`).
 */
export const PREVIEW_PAGE_PATH = '/preview';

/** The query parameter of {@link PREVIEW_PAGE_PATH} naming the preview URL to frame. */
export const PREVIEW_PAGE_PARAM = 'src';

/** The query parameter carrying the redirect's short-lived ticket for `src`. */
export const PREVIEW_PAGE_TICKET = 'ticket';

/** The host-origin-relative URL that shows `previewUrl` full size in its own tab (`ticket`: the redirect's). */
export function previewPageHref(previewUrl: string, ticket?: string): string {
  const href = `${PREVIEW_PAGE_PATH}?${PREVIEW_PAGE_PARAM}=${encodeURIComponent(previewUrl)}`;
  return ticket === undefined ? href : `${href}&${PREVIEW_PAGE_TICKET}=${encodeURIComponent(ticket)}`;
}

/** Whether `pathname` is a preview's path on a preview origin (`/__bfwc/<id>/…`), not a runtime file (`/__bfwc/sw.js`). */
export function isPreviewPath(pathname: string): boolean {
  if (!pathname.startsWith(PREVIEW_SCRIPT_PREFIX)) return false;
  const rest = pathname.slice(PREVIEW_SCRIPT_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 && PREVIEW_ID.test(rest.slice(0, slash));
}

/** The application key the page probes `*.localhost` with (any 32-hex key resolves the same way). */
export const PROBE_KEY = '0'.repeat(32);

/** Where the .NET runtime bundle is served on the relay's origin, when one is resolvable. */
export const DOTNET_BUNDLE_PREFIX = '/dotnet/';

/** Where the launcher page's own files are served on the host page's origin. */
export const PAGE_ASSET_PREFIX = '/launcher/';

/** The project directory as the runtime's processes see it. */
export const LAUNCH_PROJECT_ROOT = '/home/project';

/** Where the `.NET` runtime bundle comes from, or why there is none. */
export type LaunchDotnet = { bundleUrl: string } | { bundleUrl: null; reason: string };

/** `/__bf/launch.json`. */
export interface LaunchInfo {
  /** Stable per project directory (a hash of its path): the runtime's `id`, so preview origins are the same on every launch. */
  projectId: string;
  /** The project directory on disk (its real path): the header names the project after it when the manifest has no `name`. */
  projectDir: string;
  /** The environment asked for; null lets the page pick (the first `browser` environment, else the first). */
  environment: string | null;
  /** A project-relative HTML file (`/mockup.html`) the application shows at `/` instead of `index.html`; absent for a whole project. */
  page?: string;
  /** The manifest text (or the launcher's override); null when the project has none. */
  manifestText: string | null;
  /** Where the manifest was read, or the canonical `.builderforce/builderforce.json` when missing. */
  manifestPath: string;
  /** Where `manifestText` came from. `legacy` is a root file from an older version — read, never written. */
  manifestSource: 'file' | 'legacy' | 'override' | 'missing';
  /** Set when `manifestSource` is `legacy`. */
  deprecation?: string;
  /** The manifest at `manifestPath` resolves outside the project (a symlinked `.builderforce`): refused, never read. */
  manifestOutside?: true;
  /** A manifest is at `manifestPath` but could not be read; the reason. */
  manifestUnreadable?: string;
  /** The relay page on the shared preview origin (`https://127.0.0.1:<port>/__bfwc/relay.html`). */
  relayUrl: string;
  /** Each application's preview origin, `{key}` replaced by `previewOriginKey` (`https://{key}.localhost:<port>`). */
  previewOriginTemplate: string;
  /** The process worker on the host page's own origin: what database Workers start from (they never run on a preview origin). */
  hostWorkerUrl: string;
  dotnet: LaunchDotnet;
  /** The host supplies a model relay at {@link LAUNCH_PATHS.ai}: the page then runs `ai` resources through it. */
  aiRelay: boolean;
  /** Label overrides (English by default). */
  labels?: Partial<LauncherLabels>;
}

/** `/__bf/files`: the project tree, read-only and bounded. Paths are project-relative with `/` separators. */
export interface ProjectSnapshot {
  /** UTF-8 text files. */
  files: Record<string, string>;
  /** Every other file, base64. */
  binary: Record<string, string>;
  /** Paths left out: over a cap, or a link resolving outside the project (never dropped silently). */
  skipped: string[];
}

/** One change `/__bf/changes` streams (a server-sent event's `data`, JSON). Exactly one of the payload fields is set. */
export interface ProjectChange {
  path: string;
  content?: string;
  base64?: string;
  deleted?: true;
  /** The file changed but is over a cap (or resolves outside the project): it was not sent. */
  skipped?: true;
}

/** The caps `/__bf/files` (and each change) read under. */
export const PROJECT_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const;

/** Directory names never read or watched, wherever they sit in the tree. */
export const EXCLUDED_DIRECTORIES: readonly string[] = ['node_modules', '.git', 'dist', '.next', 'bin', 'obj', 'vendor', '__pycache__', '.venv'];
