/**
 * `url` (WHATWG URL plus the legacy `parse`/`format`/`resolve`) and
 * `querystring`. Legacy `url.parse` is still everywhere in Express-era code
 * (`parseurl`, `send`), so it returns Node's full shape.
 */

export function createQuerystringModule(): Record<string, unknown> {
  const escape = (s: string) => encodeURIComponent(s);
  const unescape = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const stringifyPrimitive = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');
  const parse = (str: string, sep = '&', eq = '=', options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string }) => {
    const out: Record<string, string | string[]> = Object.create(null);
    if (typeof str !== 'string' || !str) return out;
    const decode = options?.decodeURIComponent ?? unescape;
    const parts = str.split(sep);
    const max = options?.maxKeys ?? 1000;
    for (const part of max > 0 ? parts.slice(0, max) : parts) {
      if (!part) continue;
      const idx = part.indexOf(eq);
      const key = decode((idx >= 0 ? part.slice(0, idx) : part).replace(/\+/g, ' '));
      const value = idx >= 0 ? decode(part.slice(idx + eq.length).replace(/\+/g, ' ')) : '';
      const existing = out[key];
      if (existing === undefined) out[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else out[key] = [existing, value];
    }
    return out;
  };
  const stringify = (obj: Record<string, unknown>, sep = '&', eq = '=', options?: { encodeURIComponent?: (s: string) => string }) => {
    const encode = options?.encodeURIComponent ?? escape;
    if (!obj || typeof obj !== 'object') return '';
    return Object.keys(obj)
      .map((k) => {
        const v = obj[k];
        const ks = encode(stringifyPrimitive(k)) + eq;
        return Array.isArray(v) ? v.map((x) => ks + encode(stringifyPrimitive(x))).join(sep) : ks + encode(stringifyPrimitive(v));
      })
      .filter(Boolean)
      .join(sep);
  };
  return { parse, decode: parse, stringify, encode: stringify, escape, unescape };
}

export interface LegacyUrl {
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | Record<string, unknown> | null;
  pathname: string | null;
  path: string | null;
  href: string;
}

export function createUrlModule(qs: Record<string, any>): Record<string, unknown> {
  function parse(input: string, parseQueryString = false, slashesDenoteHost = false): LegacyUrl {
    let rest = input.trim();
    const out: LegacyUrl = { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: null, search: null, query: null, pathname: null, path: null, href: '' };
    const hashAt = rest.indexOf('#');
    if (hashAt >= 0) {
      out.hash = rest.slice(hashAt);
      rest = rest.slice(0, hashAt);
    }
    const queryAt = rest.indexOf('?');
    if (queryAt >= 0) {
      out.search = rest.slice(queryAt);
      out.query = rest.slice(queryAt + 1);
      rest = rest.slice(0, queryAt);
    } else if (parseQueryString) {
      out.search = '';
      out.query = {};
    }
    const proto = /^([a-z][a-z0-9.+-]*:)/i.exec(rest);
    if (proto) {
      out.protocol = proto[1]!.toLowerCase();
      rest = rest.slice(proto[1]!.length);
    }
    if ((proto || slashesDenoteHost) && rest.startsWith('//')) {
      out.slashes = true;
      rest = rest.slice(2);
      const end = rest.search(/[/]/);
      let authority = end >= 0 ? rest.slice(0, end) : rest;
      rest = end >= 0 ? rest.slice(end) : '';
      const at = authority.lastIndexOf('@');
      if (at >= 0) {
        out.auth = decodeURIComponent(authority.slice(0, at));
        authority = authority.slice(at + 1);
      }
      out.host = authority.toLowerCase();
      const portMatch = /:(\d*)$/.exec(out.host);
      if (portMatch) {
        out.port = portMatch[1] || null;
        out.hostname = out.host.slice(0, -portMatch[0].length);
      } else out.hostname = out.host;
      if (out.hostname.startsWith('[') && out.hostname.endsWith(']')) out.hostname = out.hostname.slice(1, -1);
      if (!rest && out.protocol && /^(https?|ftp|wss?|file):$/.test(out.protocol)) rest = '/';
    }
    out.pathname = rest || (out.slashes ? '/' : null);
    if (parseQueryString && typeof out.query === 'string') out.query = qs.parse(out.query);
    out.path = (out.pathname ?? '') + (out.search ?? '') || null;
    out.href = format(out);
    return out;
  }

  function format(obj: Partial<LegacyUrl> | URL | string): string {
    if (typeof obj === 'string') return format(parse(obj));
    if (obj instanceof URL) return obj.href;
    const protocol = obj.protocol ? (obj.protocol.endsWith(':') ? obj.protocol : obj.protocol + ':') : '';
    let host = '';
    if (obj.host) host = (obj.auth ? encodeURIComponent(obj.auth).replace(/%3A/i, ':') + '@' : '') + obj.host;
    else if (obj.hostname) host = (obj.auth ? obj.auth + '@' : '') + (obj.hostname.includes(':') ? `[${obj.hostname}]` : obj.hostname) + (obj.port ? ':' + obj.port : '');
    let search = obj.search ?? '';
    if (!search && obj.query && typeof obj.query === 'object') {
      const s = qs.stringify(obj.query);
      if (s) search = '?' + s;
    } else if (search && !search.startsWith('?')) search = '?' + search;
    const slashes = obj.slashes || (host && /^(https?|ftp|wss?|file):$/.test(protocol)) ? '//' : '';
    let pathname = obj.pathname ?? '';
    if (host && pathname && !pathname.startsWith('/')) pathname = '/' + pathname;
    const hash = obj.hash ? (obj.hash.startsWith('#') ? obj.hash : '#' + obj.hash) : '';
    return `${protocol}${slashes}${host}${pathname}${search}${hash}`;
  }

  function resolve(from: string, to: string): string {
    const base = new URL(from, 'resolve://');
    const resolved = new URL(to, base);
    if (resolved.protocol === 'resolve:') {
      const { pathname, search, hash } = resolved;
      return pathname + search + hash;
    }
    return resolved.href;
  }

  return {
    URL,
    URLSearchParams,
    parse,
    format,
    resolve,
    resolveObject: (from: string, to: string) => parse(resolve(from, to)),
    fileURLToPath: (url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      if (u.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
      return decodeURIComponent(u.pathname);
    },
    pathToFileURL: (path: string) => new URL('file://' + encodeURI(path).replace(/[?#]/g, encodeURIComponent)),
    domainToASCII: (d: string) => d,
    domainToUnicode: (d: string) => d,
    urlToHttpOptions: (u: URL) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? Number(u.port) : undefined }),
    Url: function Url() {},
  };
}
