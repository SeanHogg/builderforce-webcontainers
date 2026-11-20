/**
 * The response headers of the in-browser preview origins (make.md › PRD 31 §4 W10,
 * controls 1 and 6) — THE one owner of every string in them. Whoever serves the
 * runtime's files on a preview origin builds its headers here: the Builderforce API
 * (`preview.builderforce.ai`, `<key>-preview.builderforce.ai`) and the local launcher
 * (`./launcher/server`), each through its own {@link PreviewHeaderProfile}.
 *
 * Exported as `@seanhogg/builderforce-webcontainers/preview-headers`. Pure: no DOM,
 * no Node APIs — strings in, header records out.
 *
 * - Process Worker scripts (`process-worker.js`, `python-worker.js`, `php-worker.js`,
 *   `dotnet-worker.js`, `rust-worker.js`): the app's code runs in them, and nothing
 *   inside them is a security boundary (W10 principle 2), so the browser decides egress:
 *   the CSP on the script's own response is the Worker global's policy (CSP3). Their
 *   egress is {@link DEFAULT_CONNECT_SOURCES} (what the runtimes and their installers
 *   read) plus whatever the server grants on top (an app's declared origins from a
 *   signed policy; path-scoped own sources such as the .NET bundle). `'unsafe-eval'`
 *   because the Node worker runs app modules through `eval`/`new Function`;
 *   `'wasm-unsafe-eval'` for Pyodide, php-wasm and PGlite. No `'self'` in `connect-src`:
 *   a Worker fetch to its own origin would enter the service worker as preview ingress
 *   (identity laundering), and loopback is served in-runtime, never by `fetch`.
 * - `sw.js`: imports nothing and fetches only its own origin (the restart pass-through).
 * - `relay.html`: one inline script, framed only by the embedder, starts Workers only
 *   from its own origin, connects nowhere — so a preview that scripts it gains no egress.
 * - Every other response from a preview origin (404s, a refusal, the .NET bundle): the
 *   document policy the service worker stamps, plus `frame-ancestors`.
 *
 * Residual (method-blind): CSP cannot restrict HTTP methods. The npm registry accepts
 * token-authenticated `PUT` (publish), and `api.github.com` writes with a token, so code
 * that brings its own token could write there. The runtime never hands GitHub or npm
 * credentials to app processes; closing it fully needs read-only proxies, not a CSP.
 */

export type HeaderSet = Record<string, string>;

/**
 * The read-only hosts the runtimes and their installers need, as CSP source expressions:
 * npm tarballs and metadata, jsDelivr (Pyodide, php-wasm, PGlite, Composer's GitHub dists),
 * PyPI (micropip), Packagist metadata, NuGet reads and GitHub reads. Applied to every
 * process Worker whatever else it is granted.
 */
export const DEFAULT_CONNECT_SOURCES: readonly string[] = [
  'https://registry.npmjs.org',
  'https://cdn.jsdelivr.net',
  'https://data.jsdelivr.com',
  'https://pypi.org',
  'https://files.pythonhosted.org',
  // Path-scoped: only the read-only package metadata, not Packagist's token API.
  'https://packagist.org/packages/',
  'https://repo.packagist.org',
  // NuGet reads for `dotnet restore` (the v3 index and flat container, and the CDN it may
  // redirect to). Never `https://www.nuget.org`: that is the push (write) path. No crates.io
  // host: the Rust runtime runs prebuilt wasm and never fetches crates.
  'https://api.nuget.org',
  'https://globalcdn.nuget.org',
  'https://github.com',
  'https://api.github.com',
  'https://codeload.github.com',
  'https://raw.githubusercontent.com',
  'https://objects.githubusercontent.com',
];

/**
 * The egress every preview origin's documents get: the package CDN previews load modules
 * from (`https://esm.sh`, the runtime's default `cdn`, which it adds to every origin's
 * egress itself). Anything an application declares comes on top, only through a policy.
 */
export const PREVIEW_DEFAULT_EGRESS: readonly string[] = ['https://esm.sh'];

/** The scripts the relay may start (and register): the service worker and the five process Workers. */
export const PREVIEW_WORKER_SCRIPTS = ['sw.js', 'process-worker.js', 'python-worker.js', 'php-worker.js', 'dotnet-worker.js', 'rust-worker.js'] as const;
export type PreviewScript = (typeof PREVIEW_WORKER_SCRIPTS)[number];

const directive = (name: string, ...sources: readonly string[]) => [name, ...sources].join(' ');
const unique = (...lists: ReadonlyArray<readonly string[]>) => [...new Set(lists.flat())];
const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const;
const AGENT_CLUSTER = { 'Origin-Agent-Cluster': '?1' } as const;

/** CSP violation reporting: the `report-to` group every reporting policy names, and the `Reporting-Endpoints` value declaring it. */
export interface PreviewCspReporting {
  group: string;
  /** The `Reporting-Endpoints` header value (`<group>="<url>"`). */
  endpoints: string;
}

/** A process Worker's CSP: the default allowlist plus `extraEgress`. */
export function workerScriptCsp(extraEgress: readonly string[] = [], reporting?: PreviewCspReporting): string {
  const egress = unique(DEFAULT_CONNECT_SOURCES, extraEgress);
  return [
    directive('default-src', "'none'"),
    directive('script-src', "'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', ...egress),
    directive('worker-src', "'self'", 'blob:'),
    directive('connect-src', ...egress),
    ...(reporting ? [directive('report-to', reporting.group)] : []),
  ].join('; ');
}

/** The service worker's CSP: it imports nothing, and fetches only its own origin. */
export function serviceWorkerCsp(): string {
  return "default-src 'none'; connect-src 'self'";
}

/** The relay page's CSP: framed only by `frameAncestors`, starts Workers only from its own origin, connects nowhere. */
export function relayCsp(frameAncestors: readonly string[]): string {
  return [
    directive('default-src', "'none'"),
    directive('script-src', "'unsafe-inline'"),
    directive('worker-src', "'self'"),
    directive('connect-src', "'none'"),
    directive('base-uri', "'none'"),
    directive('form-action', "'none'"),
    directive('frame-ancestors', ...frameAncestors),
  ].join('; ');
}

export interface PreviewDocumentCspInput {
  /** The preview origin's own host (`name[:port]`, lowercase): its `ws:`/`wss:` are named explicitly. */
  host: string;
  /** The pages allowed to frame it. */
  frameAncestors: readonly string[];
  /** External sources it may reach. Default {@link PREVIEW_DEFAULT_EGRESS}. */
  egress?: readonly string[];
  reporting?: PreviewCspReporting;
}

/** What every response from a preview origin that the service worker did not serve gets: the policy the worker stamps, plus `frame-ancestors`. */
export function previewDocumentCsp({ host, frameAncestors, egress = PREVIEW_DEFAULT_EGRESS, reporting }: PreviewDocumentCspInput): string {
  const out = unique(egress);
  return [
    directive('default-src', "'self'", ...out),
    directive('script-src', "'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', ...out),
    directive('style-src', "'self'", "'unsafe-inline'", 'blob:', 'data:', ...out),
    directive('img-src', "'self'", 'data:', 'blob:', ...out),
    directive('font-src', "'self'", 'data:', ...out),
    directive('media-src', "'self'", 'data:', 'blob:', ...out),
    directive('connect-src', "'self'", `ws://${host}`, `wss://${host}`, 'blob:', 'data:', ...out),
    directive('frame-src', "'self'", 'blob:'),
    directive('form-action', "'self'", ...out),
    directive('worker-src', "'self'", 'blob:'),
    directive('frame-ancestors', ...frameAncestors),
    ...(reporting ? [directive('report-to', reporting.group)] : []),
  ].join('; ');
}

/**
 * How one server deploys the header sets: what it adds to every set the runtime's own
 * files get, whether its policies report, the script MIME type, and how long a process
 * Worker script may be cached.
 */
export interface PreviewHeaderProfile {
  /** Added first to every set (the API: `Cross-Origin-Embedder-Policy`/`-Resource-Policy`, so a COEP page can frame and load them). */
  embed?: Readonly<HeaderSet>;
  /** CSP reporting; absent: no `report-to`, no `Reporting-Endpoints`. */
  reporting?: PreviewCspReporting;
  /** The script MIME type. */
  scriptType: string;
  /** `Cache-Control` of a process Worker script. */
  workerScriptCache: string;
}

/** The header sets of a preview origin, under `profile`. */
export function previewHeaders(profile: PreviewHeaderProfile) {
  const embed = profile.embed ?? {};
  const reportingEndpoints: HeaderSet = profile.reporting ? { 'Reporting-Endpoints': profile.reporting.endpoints } : {};
  return {
    /** `relay.html`: framed only by `frameAncestors`, never cached (a deploy reaches the next boot). */
    relay(frameAncestors: readonly string[]): HeaderSet {
      return { ...embed, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': relayCsp(frameAncestors), ...NOSNIFF, ...AGENT_CLUSTER, 'Cache-Control': 'no-store' };
    },
    /** `sw.js`: browsers re-check a service worker script on navigation, so never let a cache answer for it. */
    serviceWorker(): HeaderSet {
      return { ...embed, 'Content-Type': profile.scriptType, 'Content-Security-Policy': serviceWorkerCsp(), ...NOSNIFF, 'Cache-Control': 'no-cache' };
    },
    /**
     * A process Worker script whose egress is the defaults plus `extraEgress` (a verified policy's
     * declared origins, path-scoped own sources such as `https://<host>/dotnet/` — never a bare
     * preview origin, which would let it re-enter `/__bfwc/` as preview ingress).
     */
    workerScript(extraEgress: readonly string[] = []): HeaderSet {
      return {
        ...embed,
        'Content-Type': profile.scriptType,
        'Content-Security-Policy': workerScriptCsp(extraEgress, profile.reporting),
        ...reportingEndpoints,
        ...NOSNIFF,
        'Cache-Control': profile.workerScriptCache,
      };
    },
    /** Every other response a preview origin answers (a 404, a refusal, the .NET bundle), on `host` (`name[:port]`). */
    document(host: string, frameAncestors: readonly string[], egress?: readonly string[]): HeaderSet {
      const csp = previewDocumentCsp({ host: host.toLowerCase(), frameAncestors, ...(egress ? { egress } : {}), ...(profile.reporting ? { reporting: profile.reporting } : {}) });
      return { ...embed, 'Content-Security-Policy': csp, ...reportingEndpoints, ...NOSNIFF, ...AGENT_CLUSTER };
    },
  };
}

export type PreviewHeaders = ReturnType<typeof previewHeaders>;
