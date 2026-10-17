/**
 * Cookies for virtual servers. A service worker cannot hand `Set-Cookie` to
 * the browser (it is a forbidden header on a synthesized response), so the
 * host keeps the jar itself: it stores what a server sets and sends it back as
 * the `Cookie` header on later requests — per preview and per port, which is
 * the origin a server would have had. Paths, `Max-Age`/`Expires` and deletion
 * follow RFC 6265; `HttpOnly` cookies are stored and sent but never shown to
 * page script; `Domain`, `Secure` and `SameSite` have nothing to choose between
 * (every request goes to the one server) and are kept only as metadata.
 */

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  /** Epoch ms; undefined for a session cookie (lives as long as the runtime). */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

/** RFC 6265 §5.1.4: the directory of the request path. */
export function defaultCookiePath(requestPath: string): string {
  const path = requestPath.split('?')[0] ?? '/';
  if (!path.startsWith('/')) return '/';
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** RFC 6265 §5.1.4 path-match. */
export function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  const path = requestPath.split('?')[0] || '/';
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

/** Parse one `Set-Cookie` value; undefined when malformed. `deleted` marks an already-expired cookie (a deletion). */
export function parseSetCookie(header: string, requestPath: string, now = Date.now()): (StoredCookie & { deleted: boolean }) | undefined {
  const [pair = '', ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return undefined;
  const name = pair.slice(0, eq).trim();
  if (!name) return undefined;
  const cookie: StoredCookie & { deleted: boolean } = { name, value: pair.slice(eq + 1).trim(), path: defaultCookiePath(requestPath), httpOnly: false, secure: false, deleted: false };
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attribute of attributes) {
    const i = attribute.indexOf('=');
    const key = (i < 0 ? attribute : attribute.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? '' : attribute.slice(i + 1).trim();
    if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    else if (key === 'expires') {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) expires = at;
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = value;
  }
  // Max-Age wins over Expires (§5.3 step 3).
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  else if (expires !== undefined) cookie.expires = expires;
  cookie.deleted = cookie.expires !== undefined && cookie.expires <= now;
  return cookie;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private readonly listeners = new Set<() => void>();

  /** Store `Set-Cookie` values from a response to `requestPath`; returns whether anything changed. */
  store(setCookie: string | readonly string[] | undefined, requestPath: string, now = Date.now()): boolean {
    if (!setCookie) return false;
    let changed = false;
    for (const header of typeof setCookie === 'string' ? [setCookie] : setCookie) {
      const cookie = parseSetCookie(header, requestPath, now);
      if (cookie) changed = this.put(cookie, now, true) || changed;
    }
    if (changed) this.notify();
    return changed;
  }

  /** A `document.cookie = '…'` assignment from a page at `pagePath`. Script cannot create or replace an `HttpOnly` cookie. */
  setFromDocument(assignment: string, pagePath: string, now = Date.now()): boolean {
    const cookie = parseSetCookie(assignment, pagePath, now);
    if (!cookie || cookie.httpOnly) return false;
    const changed = this.put(cookie, now, false);
    if (changed) this.notify();
    return changed;
  }

  /** The `Cookie` header for a request to `path`; undefined when no cookie applies. Longer paths first. */
  header(path: string, now = Date.now()): string | undefined {
    const text = this.matching(path, now, true);
    return text || undefined;
  }

  /** What `document.cookie` reads on a page at `path`: the same cookies, minus `HttpOnly` ones. */
  documentCookie(path: string, now = Date.now()): string {
    return this.matching(path, now, false);
  }

  /** Every live cookie. */
  list(now = Date.now()): StoredCookie[] {
    this.expire(now);
    return this.cookies.map((c) => ({ ...c }));
  }

  clear(): void {
    if (!this.cookies.length) return;
    this.cookies = [];
    this.notify();
  }

  /** The jar changed (a server or a page set or deleted a cookie). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private put(cookie: StoredCookie & { deleted: boolean }, now: number, fromHttp: boolean): boolean {
    this.expire(now);
    const index = this.cookies.findIndex((c) => c.name === cookie.name && c.path === cookie.path);
    const existing = index < 0 ? undefined : this.cookies[index];
    if (existing?.httpOnly && !fromHttp) return false;
    const { deleted, ...stored } = cookie;
    if (deleted) {
      if (index < 0) return false;
      this.cookies.splice(index, 1);
      return true;
    }
    if (existing && existing.value === stored.value && existing.expires === stored.expires && existing.httpOnly === stored.httpOnly) return false;
    if (index < 0) this.cookies.push(stored);
    else this.cookies[index] = stored;
    return true;
  }

  private matching(path: string, now: number, includeHttpOnly: boolean): string {
    this.expire(now);
    return this.cookies
      .filter((c) => (includeHttpOnly || !c.httpOnly) && cookiePathMatches(c.path, path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  private expire(now: number): void {
    const live = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    if (live.length === this.cookies.length) return;
    this.cookies = live;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** One jar per virtual server port — what the preview host keeps for its runtime. */
export class PortCookieJars {
  private readonly jars = new Map<number, CookieJar>();
  private readonly listeners = new Set<(port: number) => void>();

  jar(port: number): CookieJar {
    let jar = this.jars.get(port);
    if (!jar) {
      jar = new CookieJar();
      jar.onChange(() => {
        for (const listener of this.listeners) listener(port);
      });
      this.jars.set(port, jar);
    }
    return jar;
  }

  /** Some port's jar changed. */
  onChange(listener: (port: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    for (const jar of this.jars.values()) jar.clear();
  }
}
