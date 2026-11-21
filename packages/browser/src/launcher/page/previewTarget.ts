/**
 * Which service the preview frame shows — pure, so every choice is tested without a browser.
 *
 * A service is previewable when it serves HTTP on a port: an application (never a
 * `database` — its port is not HTTP, and the runtime gives it no preview URL), with a
 * port, and a URL the runtime has assigned for that port (`ServiceSnapshot.url`, the
 * one place a preview URL is derived). A port-less one-off is never previewable.
 *
 * With nothing chosen the preview shows the default (`primaryServiceOf`: the first
 * frontend, else the first service serving a page). A chosen service stays chosen
 * while it is on its way back — starting, stopping, a crash the runtime will restart
 * (`failed` with `error.willRestart`), or `stopped` during a restart the user asked for
 * (`held`): the default shows meanwhile (`waiting`), and the preview returns to it when
 * it serves again. Once it stops for good, fails for good or is gone, the choice ends
 * and the default shows, with the choice reported as `lost`.
 */
import type { ServiceType } from '@seanhogg/builderforce-webcontainers-core/app';
import { primaryServiceOf } from './launchPlan.js';

export interface PreviewableService {
  id: string;
  type: ServiceType;
  role?: string;
  state: string;
  port?: number;
  url?: string;
  /** The last error (`ServiceSnapshot.error`): `willRestart` says the runtime restarts it. */
  error?: { willRestart: boolean };
}

const DOWN_STATES: ReadonlySet<string> = new Set(['stopped', 'failed']);

/** True when `service` serves HTTP on a port the preview can frame (a stopped or failed one does not, whatever URL it last had). */
export function isPreviewable(service: PreviewableService): boolean {
  return service.type !== 'database' && service.port !== undefined && !!service.url && !DOWN_STATES.has(service.state);
}

export interface PreviewResolution<T> {
  /** The service the frame shows; undefined when none serves a page. */
  target?: T;
  /** The choice that still stands (to keep for the next update). */
  selected?: string;
  /** The chosen service that is not serving right now (the default shows until it is). */
  waiting?: string;
  /** The choice that just ended: the service stopped or failed for good, or is gone. */
  lost?: string;
}

/** The default preview: the primary service among the previewable ones. */
export function defaultPreviewOf<T extends PreviewableService>(services: readonly T[]): T | undefined {
  return primaryServiceOf(services.filter(isPreviewable));
}

/** True when `service`, not serving now, is coming back on its own (or through the restart `held` names). */
function comingBack(service: PreviewableService, held: boolean): boolean {
  if (service.state === 'failed') return service.error?.willRestart === true;
  if (service.state === 'stopped') return held;
  return true;
}

/**
 * The preview for `services`, given the service chosen so far (if any). `held` is true
 * while a restart of the chosen service, asked for on this page, is under way: its
 * `stopped` step then waits instead of ending the choice.
 */
export function resolvePreviewTarget<T extends PreviewableService>(services: readonly T[], selected?: string, held = false): PreviewResolution<T> {
  const fallback = defaultPreviewOf(services);
  const withTarget = (resolution: PreviewResolution<T>): PreviewResolution<T> => (fallback ? { target: fallback, ...resolution } : resolution);
  if (selected === undefined) return withTarget({});
  const chosen = services.find((service) => service.id === selected);
  if (!chosen || chosen.type === 'database') return withTarget({ lost: selected });
  if (isPreviewable(chosen)) return { target: chosen, selected };
  if (comingBack(chosen, held)) return withTarget({ selected, waiting: selected });
  return withTarget({ lost: selected });
}

/**
 * The choice across live updates: `select(id)` chooses, `holdThroughRestart(id)` keeps
 * it through a restart of that service, `resolve(services)` answers every update. A
 * `lost` choice keeps being reported (the notice stays) until the next `select`, or
 * until that service serves a page again.
 */
export function createPreviewSelection() {
  let selected: string | undefined;
  // A restart's hold: asked for, then down (seen not serving); it ends once the service serves again or the choice ends.
  let hold: 'none' | 'asked' | 'down' = 'none';
  let lost: string | undefined;
  return {
    select(serviceId: string): void {
      selected = serviceId;
      hold = 'none';
      lost = undefined;
    },
    /** A restart of `serviceId` was asked for: when it is the chosen one, its stop does not end the choice. */
    holdThroughRestart(serviceId: string): void {
      if (serviceId === selected) hold = 'asked';
    },
    resolve<T extends PreviewableService>(services: readonly T[]): Omit<PreviewResolution<T>, 'selected'> {
      const resolution = resolvePreviewTarget(services, selected, hold !== 'none');
      selected = resolution.selected;
      if (resolution.lost) hold = 'none';
      else if (resolution.waiting && hold !== 'none') hold = 'down';
      else if (hold === 'down') hold = 'none';
      if (resolution.lost) lost = resolution.lost;
      if (lost !== undefined) {
        const again = services.find((service) => service.id === lost);
        if (again && isPreviewable(again)) lost = undefined;
      }
      return {
        ...(resolution.target ? { target: resolution.target } : {}),
        ...(resolution.waiting ? { waiting: resolution.waiting } : {}),
        ...(lost ? { lost } : {}),
      };
    },
  };
}
