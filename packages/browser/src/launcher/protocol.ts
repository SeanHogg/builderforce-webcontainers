/**
 * The local launcher's wire contract (make.md › PRD 31 §4 W11, "Local launch from
 * the VSIX"): what the Node server (`./launcher/server`) answers and what the
 * launcher page (`dist/launcher/page.js`) reads. Pure types and constants, shared
 * by both sides, so neither spells a path or a header twice.
 */
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
} as const;

/** Where the runtime's files are served on every preview origin (the relay's and each application's). */
export const PREVIEW_SCRIPT_PREFIX = '/__bfwc/';

/**
 * The probe every preview origin answers the host page (204, readable by the page's
 * origin only): fetched before booting, it proves the relay and the `*.localhost`
 * application origins resolve and that their certificates are trusted.
 */
export const PREVIEW_PROBE_PATH = '/__bfwc/probe';

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
  /** The environment asked for; null lets the page pick (the first `browser` environment, else the first). */
  environment: string | null;
  /** The manifest text (or the launcher's override); null when the project has none. */
  manifestText: string | null;
  /** Where the manifest was read, or the canonical `.builderforce/builderforce.json` when missing. */
  manifestPath: string;
  /** Where `manifestText` came from. `legacy` is a root file from an older version — read, never written. */
  manifestSource: 'file' | 'legacy' | 'override' | 'missing';
  /** Set when `manifestSource` is `legacy`. */
  deprecation?: string;
  /** The relay page on the shared preview origin (`https://127.0.0.1:<port>/__bfwc/relay.html`). */
  relayUrl: string;
  /** Each application's preview origin, `{key}` replaced by `previewOriginKey` (`https://{key}.localhost:<port>`). */
  previewOriginTemplate: string;
  /** The process worker on the host page's own origin: what database Workers start from (they never run on a preview origin). */
  hostWorkerUrl: string;
  dotnet: LaunchDotnet;
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
