/**
 * The services list's filter — pure, so it is tested without a browser.
 *
 * - `running` (the default): every service that is not `stopped` — on its way up
 *   (discovered, preparing, starting), up (ready, running), on its way down
 *   (stopping) and every `failed` one (a failure is never hidden). A one-off setup
 *   service (exit-zero readiness) that finished is `stopped`, so it shows under `all` only.
 * - `all`: every service.
 *
 * The choice lasts for the page session (`sessionStorage`), read and written through
 * a storage that may be missing or throw (a private window, blocked site data).
 */
export type ServiceFilter = 'running' | 'all';

export const DEFAULT_SERVICE_FILTER: ServiceFilter = 'running';
export const SERVICE_FILTER_STORAGE_KEY = 'bfwc.launcher.servicesFilter';

export interface FilteredServices<T> {
  shown: T[];
  hidden: T[];
}

export function filterServices<T extends { state: string }>(services: readonly T[], filter: ServiceFilter): FilteredServices<T> {
  if (filter === 'all') return { shown: [...services], hidden: [] };
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const service of services) (service.state === 'stopped' ? hidden : shown).push(service);
  return { shown, hidden };
}

type FilterStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The filter chosen earlier in this page session, else the default. */
export function readServiceFilter(storage: () => FilterStorage | undefined): ServiceFilter {
  try {
    const value = storage()?.getItem(SERVICE_FILTER_STORAGE_KEY);
    return value === 'all' || value === 'running' ? value : DEFAULT_SERVICE_FILTER;
  } catch {
    // Storage blocked (private window, site data off): the filter is a per-viewer convenience, so the default stands — nothing to report.
    return DEFAULT_SERVICE_FILTER;
  }
}

/** Remember `filter` for this page session; true when it was stored (a page without storage keeps it in memory only). */
export function writeServiceFilter(storage: () => FilterStorage | undefined, filter: ServiceFilter): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(SERVICE_FILTER_STORAGE_KEY, filter);
    return true;
  } catch {
    // Storage blocked or full: the choice still holds in memory for this page; the false return says it was not stored.
    return false;
  }
}
