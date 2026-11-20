/**
 * The launcher's origins, all on one loopback port and told apart by the `Host`
 * header (make.md › PRD 31 §4 W11, W10 control 1) — and, over TLS, by the SNI
 * server name first:
 *
 * - `https://localhost:<port>`: the host page (and the `/__bf/*` API);
 * - `https://127.0.0.1:<port>`: the shared preview origin (the relay);
 * - `https://<key>.localhost:<port>`: one per application, `<key>` being the runtime's
 *   `previewOriginKey` (32 lowercase hex).
 *
 * (`http://` only with `tls: false`, for tests: the runtime refuses http preview
 * origins, so nothing runs there.) A request naming any other host is refused: that
 * is the DNS-rebinding guard (a page on `evil.example` that rebinds its name to
 * 127.0.0.1 still sends `Host: evil.example`).
 */

export type LauncherOrigin = { kind: 'page' } | { kind: 'relay' } | { kind: 'app'; key: string };

const APP_HOST = /^([0-9a-f]{32})\.localhost$/;

/** Which of the launcher's origins a host NAME (no port; an SNI server name) is; null for any other name. */
export function classifyHostname(name: string): LauncherOrigin | null {
  const value = name.toLowerCase();
  if (value === 'localhost') return { kind: 'page' };
  if (value === '127.0.0.1') return { kind: 'relay' };
  const app = APP_HOST.exec(value);
  return app ? { kind: 'app', key: app[1]! } : null;
}

export interface LauncherHosts {
  readonly port: number;
  /** `https` (or `http` with `tls: false`). */
  readonly scheme: 'https' | 'http';
  /** `https://localhost:<port>`. */
  readonly pageOrigin: string;
  /** `https://127.0.0.1:<port>`. */
  readonly relayOrigin: string;
  /** `https://{key}.localhost:<port>`. */
  readonly appOriginTemplate: string;
  /** Which origin a `Host` header names; null for any host that is not one of ours. */
  classify(host: string | undefined): LauncherOrigin | null;
  /** Which origin an `Origin` header (`scheme://host:port`) is; null for any other. */
  classifyOrigin(origin: string | undefined): LauncherOrigin | null;
}

export function launcherHosts(port: number, scheme: 'https' | 'http' = 'https'): LauncherHosts {
  const suffix = `:${port}`;
  const classify = (host: string | undefined): LauncherOrigin | null => {
    if (typeof host !== 'string') return null;
    const value = host.toLowerCase();
    if (!value.endsWith(suffix)) return null;
    return classifyHostname(value.slice(0, -suffix.length));
  };
  return {
    port,
    scheme,
    pageOrigin: `${scheme}://localhost${suffix}`,
    relayOrigin: `${scheme}://127.0.0.1${suffix}`,
    appOriginTemplate: `${scheme}://{key}.localhost${suffix}`,
    classify,
    classifyOrigin(origin) {
      if (typeof origin !== 'string' || !origin.toLowerCase().startsWith(`${scheme}://`)) return null;
      return classify(origin.slice(scheme.length + 3));
    },
  };
}
