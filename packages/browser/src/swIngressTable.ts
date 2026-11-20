/**
 * The service worker's ingress tables (make.md › PRD 31 §4 W11): each preview's
 * routes (the application's, from its spec), as the host sent them on that
 * preview's attached port (`WireIngress`) — the only place they come from. A
 * worker restart forgets them; the re-attach brings them back.
 *
 * Routing by a table (`route`):
 * - a dev-server document (no virtual server served it): the longest matching
 *   route; the catch-all `/` is the dev server itself (the frontend it serves);
 * - a page a virtual server served (`/__port/N/…`): only the non-catch-all
 *   routes. Its absolute URLs (`/static/app.css`) belong to the server that
 *   served it, so the catch-all never takes them — the router's own-server
 *   remap does (`swRouter`).
 */
import { matchIngressRoute, type RequestOrigin, type WireIngressRoute } from './protocol.js';

/** Where a routed request goes: a preview path, and who made it (`from`) when it is a port request. */
export interface IngressTarget {
  id: string;
  path: string;
  search: string;
  from?: RequestOrigin;
}

export interface SwIngressTableOptions {
  /** How long to wait for a table after asking for a re-attach. */
  waitMs: number;
  /** Ask open pages to re-attach `id` (its attach carries the table). */
  requestAttach(id: string): void;
}

export function createSwIngressTable(options: SwIngressTableOptions) {
  const tables = new Map<string, WireIngressRoute[]>();
  /** Previews whose table arrived since the worker started (an empty one included), and requests waiting for one. */
  const known = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  function set(id: string, routes: WireIngressRoute[]): void {
    if (routes.length) tables.set(id, routes);
    else tables.delete(id);
    known.add(id);
    for (const wake of waiters.get(id) ?? []) wake();
    waiters.delete(id);
  }

  /** After a restart: ask for `id` again and wait, briefly, for its table. */
  async function await_(id: string): Promise<void> {
    if (known.has(id)) return;
    const arrived = new Promise<void>((resolve) => {
      waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
      setTimeout(resolve, options.waitMs);
    });
    options.requestAttach(id);
    await arrived;
  }

  /** `id` detached: forget its table. */
  function forget(id: string): void {
    tables.delete(id);
    known.delete(id);
  }

  /**
   * A same-origin request outside the preview prefix from a page of preview `id`,
   * routed by its table (see the module doc). `server`: the virtual server that
   * served the page, if one did. Null: no table, or no route applies.
   */
  function route(id: string, url: URL, server: { port: number } | undefined): IngressTarget | null {
    const routes = tables.get(id) ?? [];
    const route = matchIngressRoute(server ? routes.filter((candidate) => candidate.path !== '/') : routes, url.pathname);
    if (!route) return null;
    if (!server && route.path === '/') return { id, path: url.pathname, search: url.search };
    const from: RequestOrigin = server ? { port: server.port, ingress: true } : { ingress: true };
    return { id, path: `/__port/${route.port}${url.pathname}`, search: url.search, from };
  }

  return { set, await: await_, forget, route };
}

export type SwIngressTable = ReturnType<typeof createSwIngressTable>;
