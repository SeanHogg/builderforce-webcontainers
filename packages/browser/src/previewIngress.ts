/**
 * Application ingress in the browser (make.md › PRD 31 §4 W11): a frontend's
 * relative `fetch('/api/items')` reaches the backend its manifest routes `/api`
 * to, as a deployment's ingress would.
 *
 * The table comes from the application's spec only: `startApplicationRuntime`
 * registers it here (`PreviewRuntime.registerIngress`), and the host sends it to
 * each preview origin's service worker on the attached port (`WireIngress`),
 * which only the host holds — never from preview content. The worker maps a
 * same-origin request outside `/__bfwc/` by its longest matching route to
 * `/__bfwc/<id>/__port/<port>/<path>` and marks it as the page's (`from`).
 *
 * Ingress only ever NARROWS (W10 controls 1 and 4). A page's port request must
 * first pass the origin check it always did (`mayServePort`: only through the
 * port owner's preview origin); ingress then picks a stricter caller — the
 * service whose port served the page, or, for a dev-server document of the
 * application, its frontend — so the port registry allows it only along a
 * declared `dependsOn` edge (or to the page's own service). A page whose server
 * is not an application's (the workspace's, the platform's) never acts as a
 * frontend: its ingress-routed requests are refused.
 *
 * The one grant beyond the origin check: the instant preview of an
 * application's frontend. When a process ATTRIBUTED to an application (its
 * page-side SecurityContext, never the message) announced a dev-server handoff
 * (`vite`, `ng serve`), the shared origin's dev server serves that application's
 * frontend — so while that handoff is live, a dev-server document on the shared
 * origin acts as that application's frontend, for that application's ports only.
 * Only when the announcing process IS that application's frontend service, and
 * the handoff serves neither the whole project nor a directory holding another
 * registered application (`handoffApplication`); one application's live handoff
 * is never replaced by another's (`ingress.handoff_conflict`, the process host).
 *
 * Which table an origin serves: an application's own preview origin, that
 * application's; the shared origin, the live handoff's application's, else
 * (only under the named opt-out, an application with no origin of its own) the
 * most recently registered application served on the shared origin.
 */
import { ingressTable, type ApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { isApplicationId, normalizePath, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { RequestOrigin, WireIngressRoute } from './protocol.js';

interface Registration {
  applicationId: string;
  routes: WireIngressRoute[];
  frontend?: string;
  /** Its services' directories, project-relative (`/` when a service names none). */
  directories: string[];
}

/** Whether project-relative `directory` is `ancestor` or inside it. */
const within = (directory: string, ancestor: string) => ancestor === '/' || directory === ancestor || directory.startsWith(`${ancestor}/`);
const projectDirectory = (path: string | undefined) => normalizePath(`/${path ?? ''}`);

/** A page's port request may go ahead, acting as `caller` (absent: the platform, as before ingress). */
export interface IngressVerdict {
  caller?: SecurityContext;
}

/** One origin's view of the ingress: what its worker routes by, and who its pages act as. */
export interface IngressView {
  /** The table this origin's worker routes by (empty: none). */
  routes(): WireIngressRoute[];
  /** The table changed (an application started or stopped, a handoff began or ended): send it again. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /**
   * Whether a port request a preview page on this origin made (`from`) may reach
   * `port`, and as whom; null: refused. `admitted` is the origin check
   * (`mayServePort`), required for everything but the live handoff's frontend.
   */
  decide(port: number, from: RequestOrigin, admitted: () => boolean): IngressVerdict | null;
}

export interface PreviewIngressOptions {
  /** Who listens on `port` (the port registry's owner). */
  ownerOf(port: number): SecurityContext | undefined;
  /** The application whose attributed process announced the live dev-server handoff, if any (the shared origin's dev server serves its frontend). */
  handoffApplication?(): string | undefined;
  /** Whether `applicationId` is served on the shared origin (no origin of its own: the named opt-out). Default: none is. */
  onSharedOrigin?(applicationId: string): boolean;
}

export interface PreviewIngress {
  /** Put `applicationId`'s ingress in force; returns the unregister. */
  register(applicationId: string, spec: ApplicationSpec): () => void;
  /** The view for `applicationId`'s own origin, or (undefined) the shared origin's. */
  view(applicationId: string | undefined): IngressView;
  /** Something a view depends on changed (the live handoff): every view's worker gets its table again. */
  refresh(): void;
  /**
   * The application a live dev-server handoff serves the frontend of, or undefined: its identity is honoured only
   * when the announcing process (`context`, page-side) is that registered application's frontend service (the `/`
   * route's service, else its single frontend-role service — `ingressTable`), and void when the served directory
   * (`served`, project-relative) is the whole project or contains another registered application's directory.
   */
  handoffApplication(context: SecurityContext | undefined, served: string): string | undefined;
}

export function createPreviewIngress(options: PreviewIngressOptions): PreviewIngress {
  const { ownerOf } = options;
  /** In registration order: the latest wins. */
  const registrations: Registration[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const latest = (applicationId: string) => [...registrations].reverse().find((registration) => registration.applicationId === applicationId);

  function register(applicationId: string, spec: ApplicationSpec): () => void {
    const table = ingressTable(spec);
    const registration: Registration = {
      applicationId,
      routes: table.routes.map(({ path, port }) => ({ path, port })),
      directories: spec.services.map((service) => projectDirectory(service.root)),
    };
    if (table.frontend !== undefined) registration.frontend = table.frontend;
    registrations.push(registration);
    changed();
    return () => {
      const at = registrations.indexOf(registration);
      if (at < 0) return;
      registrations.splice(at, 1);
      changed();
    };
  }

  function view(applicationId: string | undefined): IngressView {
    const shared = applicationId === undefined;
    /** The live handoff's application, when it is the one this (shared) view serves. */
    const handoff = () => (shared ? options.handoffApplication?.() : undefined);
    const current = (): Registration | undefined => {
      if (!shared) return latest(applicationId);
      const bound = handoff();
      const handedOff = bound === undefined ? undefined : latest(bound);
      return handedOff ?? [...registrations].reverse().find((registration) => options.onSharedOrigin?.(registration.applicationId) ?? false);
    };
    const frontendOf = (registration: Registration): SecurityContext | undefined =>
      registration.frontend === undefined ? undefined : Object.freeze({ applicationId: registration.applicationId, serviceId: registration.frontend });

    /** The stricter caller for a request to one of the view's application's ports; null: refuse; undefined: ingress has no say (origin decides). */
    function callerFor(registration: Registration | undefined, port: number, from: RequestOrigin): SecurityContext | null | undefined {
      const noSay = from.ingress ? null : undefined;
      const owner = ownerOf(port);
      if (!registration || (owner && owner.applicationId !== registration.applicationId)) return noSay;
      if (from.port !== undefined) {
        // A page a virtual server served acts as that service; another application's stays its own (the registry refuses it,
        // `port.not_owner`). The workspace's or the platform's page never becomes the frontend.
        const page = ownerOf(from.port);
        return page && isApplicationId(page.applicationId) ? page : noSay;
      }
      // A dev-server document is the application's only on its own origin, or on the shared origin while its handoff is live.
      const documentIsApplications = !shared || handoff() === registration.applicationId;
      return (documentIsApplications ? frontendOf(registration) : undefined) ?? noSay;
    }

    return {
      routes: () => current()?.routes.map((route) => ({ ...route })) ?? [],
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      decide(port, from, admitted) {
        const registration = current();
        const caller = callerFor(registration, port, from);
        if (caller === null) return null;
        // The instant preview of the live handoff's frontend: its document reaches its own application's ports, as its frontend.
        const owner = ownerOf(port);
        const handedOff = caller !== undefined && from.port === undefined && handoff() !== undefined && handoff() === registration?.applicationId && owner?.applicationId === registration?.applicationId;
        if (handedOff) return { caller };
        if (!admitted()) return null;
        return caller ? { caller } : {};
      },
    };
  }

  function handoffApplication(context: SecurityContext | undefined, served: string): string | undefined {
    const applicationId = context?.applicationId;
    if (!isApplicationId(applicationId)) return undefined;
    const registration = latest(applicationId);
    if (registration?.frontend === undefined || registration.frontend !== context!.serviceId) return undefined;
    const directory = projectDirectory(served);
    if (directory === '/') return undefined;
    const others = registrations.filter((other) => other.applicationId !== applicationId);
    return others.some((other) => other.directories.some((owned) => within(owned, directory))) ? undefined : applicationId;
  }

  return { register, view, refresh: changed, handoffApplication };
}
