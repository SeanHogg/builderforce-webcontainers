/// <reference types="node" />
/**
 * `createLocalLauncher` (make.md › PRD 31 §4 W11, "Local launch from the VSIX"):
 * a loopback HTTPS server whose URL, opened in an ordinary browser, runs the
 * project's `builderforce.json` application in this runtime and shows it.
 *
 * One port, several origins told apart by SNI and `Host` (`hosts.ts`): the host
 * page on `localhost`, the relay on `127.0.0.1`, one `<key>.localhost` per
 * application — so control 1's per-application origins hold locally, and every one
 * of them is https like production (the runtime refuses http preview origins). Each
 * host gets its own leaf certificate from the user's local CA (`tls/`), issued on
 * first use. It binds 127.0.0.1 only, refuses every other server name and `Host`
 * (DNS rebinding), and its `/__bf/*` API needs the random per-launch token the URL
 * carries (in its fragment).
 *
 * The browser warns until the CA is trusted: `caTrustCommand(launcher.ca)` is the
 * step, run by the caller after the user approves it (`bfwc-launch --trust`, the VSIX).
 */
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LauncherLabels } from '../labels.js';
import { LAUNCH_TOKEN_PARAM } from '../protocol.js';
import { resolveDotnetBundle } from './dotnetBundle.js';
import { classifyHostname, launcherHosts, type LauncherHosts } from './hosts.js';
import { requestUrl, sendText } from './httpResponses.js';
import { loadLauncherAssets } from './launcherAssets.js';
import { buildLaunchInfo, projectIdOf } from './launchInfo.js';
import { servePageOrigin } from './pageRoutes.js';
import { servePreviewOrigin } from './previewRoutes.js';
import { readProjectTree, type ProjectLimits } from './projectFiles.js';
import { createProjectWatch } from './projectWatch.js';
import { createLeafCache } from './tls/issueCert.js';
import { loadOrCreateLocalCa, type LocalCa } from './tls/localCa.js';
import { createSniCallback } from './tls/sni.js';

/** Where the local CA lives unless `tls.storeDir` says otherwise. */
export function defaultCaStoreDir(): string {
  return join(homedir(), '.builderforce', 'launcher-ca');
}

export interface LocalLauncherOptions {
  /** The project directory: its `builderforce.json` and its files. */
  projectDir: string;
  /** The manifest environment to run; default: the first `browser` environment, else the first. */
  environment?: string;
  /** The manifest's text, used instead of `builderforce.json` (a project without one, detected in memory). */
  manifestText?: string;
  /** The port (default 0: a free one). */
  port?: number;
  /** Label overrides for the page (English by default). */
  labels?: Partial<LauncherLabels>;
  /** The .NET runtime bundle's directory; default `@seanhogg/builderforce-webcontainers-dotnet` when it resolves. */
  dotnetBundleDir?: string;
  /** This package's built `dist/` (default: found beside this module). `assetsDir` is the same directory under its PRD 49 name. */
  distDir?: string;
  /** Alias of `distDir`: the built asset directory the launcher serves. */
  assetsDir?: string;
  /** When set, preview pages may POST `/__bfwc/report` with header `x-bfwc-report-token`. */
  reportToken?: string;
  /** Override the tree caps (tests). */
  limits?: ProjectLimits;
  /** The change stream's debounce (default 120ms). */
  watchDebounceMs?: number;
  /**
   * HTTPS with the user's local CA (default: stored in `~/.builderforce/launcher-ca`).
   * `false` serves plain http — tests only: the runtime refuses http preview origins,
   * so the page refuses to boot an application there.
   */
  tls?: { storeDir: string } | false;
}

export interface LocalLauncher {
  /** Open this in a browser: `https://localhost:<port>/#token=<token>`. */
  readonly url: string;
  readonly port: number;
  /** The project id the runtime runs under (stable per project directory). */
  readonly projectId: string;
  /** The local CA's PEM certificate (what a browser must trust); null with `tls: false`. */
  readonly caCertPath: string | null;
  /** The local CA (its PEM/DER paths, for `caTrustCommand`); null with `tls: false`. */
  readonly ca: LocalCa | null;
  /** Stop serving: ends every change stream, stops the watch, frees the port. */
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function createLocalLauncher(options: LocalLauncherOptions): Promise<LocalLauncher> {
  const root = await realpath(options.projectDir);
  const assets = await loadLauncherAssets(options.distDir ?? options.assetsDir);
  const projectId = projectIdOf(root);
  const token = randomBytes(24).toString('base64url');
  const dotnet = resolveDotnetBundle(root, options.dotnetBundleDir);
  const tls = options.tls === undefined ? { storeDir: defaultCaStoreDir() } : options.tls;
  const ca = tls === false ? null : await loadOrCreateLocalCa(tls.storeDir);
  const scheme = ca ? 'https' : 'http';
  const watch = createProjectWatch(root, { debounceMs: options.watchDebounceMs, limits: options.limits });
  const streams = new Set<ServerResponse>();
  let hosts: LauncherHosts | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = hosts!.classify(req.headers.host);
    if (!origin) return sendText(req, res, 403, {}, 'Unknown host.');
    const url = requestUrl(req, origin.kind === 'page' ? hosts!.pageOrigin : `${scheme}://${req.headers.host}`);
    if (!url) return sendText(req, res, 400, {}, 'Bad request.');
    if (origin.kind === 'page') {
      return servePageOrigin(req, res, url, {
        hosts: hosts!,
        assets,
        token,
        watch,
        streams,
        launchInfo: () => buildLaunchInfo({ root, projectId, hosts: hosts!, environment: options.environment, manifestText: options.manifestText, dotnet, labels: options.labels }),
        files: () => readProjectTree(root, options.limits),
      });
    }
    return servePreviewOrigin(req, res, url, req.headers.host!.toLowerCase(), { hosts: hosts!, assets, dotnetDir: dotnet.dir, reportToken: options.reportToken });
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bfwc-launch] ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) sendText(req, res, 500, {}, 'The launcher failed to answer.');
      else res.destroy();
    });
  };
  let server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  if (ca) {
    // A leaf per host on first use; a name the Host allowlist refuses gets none. A client sends no SNI for an IP
    // literal, so the default certificate is the relay's (127.0.0.1).
    const leaves = createLeafCache(ca);
    const relay = leaves.issue('127.0.0.1');
    server = createHttpsServer({ key: relay.keyPem, cert: relay.certPem, SNICallback: createSniCallback(leaves, (name) => classifyHostname(name) !== null) }, handler);
  } else {
    server = createHttpServer(handler);
  }
  const port = await listen(server, options.port ?? 0);
  hosts = launcherHosts(port, scheme);

  let closing: Promise<void> | undefined;
  return {
    url: `${hosts.pageOrigin}/#${LAUNCH_TOKEN_PARAM}=${token}`,
    port,
    projectId,
    caCertPath: ca?.certPath ?? null,
    ca,
    close() {
      closing ??= new Promise<void>((resolve) => {
        watch.close();
        for (const stream of [...streams]) stream.end();
        streams.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
