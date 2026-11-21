/**
 * The launcher's services filter (`serviceFilter.ts`): Running hides only stopped
 * services (finished setup steps), never a failure; All shows everything; the choice
 * lasts for the page session and survives missing or throwing storage.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVICE_FILTER, filterServices, readServiceFilter, SERVICE_FILTER_STORAGE_KEY, writeServiceFilter } from '../../src/launcher/page/serviceFilter.js';

const services = [
  { id: 'db', state: 'running' },
  { id: 'install-web', state: 'stopped' },
  { id: 'install-api', state: 'stopped' },
  { id: 'api', state: 'starting' },
  { id: 'worker', state: 'failed' },
  { id: 'web', state: 'ready' },
  { id: 'queued', state: 'discovered' },
];

describe('filterServices', () => {
  it('Running shows everything not stopped, failures included, and counts the hidden', () => {
    const { shown, hidden } = filterServices(services, 'running');
    expect(shown.map((service) => service.id)).toEqual(['db', 'api', 'worker', 'web', 'queued']);
    expect(hidden.map((service) => service.id)).toEqual(['install-web', 'install-api']);
  });

  it('All shows everything, in order', () => {
    expect(filterServices(services, 'all')).toEqual({ shown: services, hidden: [] });
  });
});

describe('the filter choice', () => {
  function memoryStorage() {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
  }

  it('defaults to Running and remembers a choice', () => {
    const storage = memoryStorage();
    expect(readServiceFilter(() => storage)).toBe(DEFAULT_SERVICE_FILTER);
    expect(DEFAULT_SERVICE_FILTER).toBe('running');
    expect(writeServiceFilter(() => storage, 'all')).toBe(true);
    expect(storage.items.get(SERVICE_FILTER_STORAGE_KEY)).toBe('all');
    expect(readServiceFilter(() => storage)).toBe('all');
  });

  it('ignores an unknown stored value, and missing or throwing storage', () => {
    const storage = memoryStorage();
    storage.setItem(SERVICE_FILTER_STORAGE_KEY, 'bogus');
    expect(readServiceFilter(() => storage)).toBe('running');
    expect(readServiceFilter(() => undefined)).toBe('running');
    expect(writeServiceFilter(() => undefined, 'all')).toBe(false);
    const throwing = () => {
      throw new Error('blocked');
    };
    expect(readServiceFilter(throwing)).toBe('running');
    expect(writeServiceFilter(throwing, 'all')).toBe(false);
  });
});
