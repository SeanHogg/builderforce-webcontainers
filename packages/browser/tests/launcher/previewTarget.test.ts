/**
 * Which service the launcher's preview shows (`previewTarget.ts`): only HTTP services
 * on a port are previewable (never a database, never a port-less one-off); the default
 * is the frontend; a chosen service holds through a restart and ends when it stops,
 * fails or disappears.
 */
import { describe, expect, it } from 'vitest';
import { createPreviewSelection, defaultPreviewOf, isPreviewable, resolvePreviewTarget, type PreviewableService } from '../../src/launcher/page/previewTarget.js';

const db: PreviewableService = { id: 'db', type: 'database', state: 'running', port: 5432 };
const install: PreviewableService = { id: 'install-web', type: 'application', state: 'stopped' };
const api: PreviewableService = { id: 'api', type: 'application', role: 'backend', state: 'running', port: 8000, url: 'https://api.example/' };
const web: PreviewableService = { id: 'web', type: 'application', role: 'frontend', state: 'running', port: 5173, url: 'https://web.example/' };
const services = [db, install, api, web];

describe('isPreviewable', () => {
  it('is an application with a port and a preview URL', () => {
    expect(isPreviewable(web)).toBe(true);
    expect(isPreviewable(api)).toBe(true);
    expect(isPreviewable(install)).toBe(false);
    expect(isPreviewable({ ...api, url: undefined })).toBe(false);
    expect(isPreviewable({ ...api, port: undefined })).toBe(false);
  });

  it('not while stopped or failed, even with the URL it last had', () => {
    expect(isPreviewable({ ...api, state: 'failed' })).toBe(false);
    expect(isPreviewable({ ...api, state: 'stopped' })).toBe(false);
    expect(defaultPreviewOf([{ ...web, state: 'failed' }, api])?.id).toBe('api');
  });

  it('never a database, by type — whatever it is named or serves', () => {
    expect(isPreviewable(db)).toBe(false);
    expect(isPreviewable({ ...db, id: 'web', url: 'https://db.example/' })).toBe(false);
  });
});

describe('resolvePreviewTarget', () => {
  it('shows the frontend by default', () => {
    expect(defaultPreviewOf(services)?.id).toBe('web');
    expect(resolvePreviewTarget(services)).toEqual({ target: web });
  });

  it('shows a chosen previewable service', () => {
    expect(resolvePreviewTarget(services, 'api')).toEqual({ target: api, selected: 'api' });
  });

  it('keeps the choice while the service restarts, showing the default meanwhile', () => {
    const restarting = { ...api, state: 'starting', url: undefined };
    expect(resolvePreviewTarget([db, restarting, web], 'api')).toEqual({ target: web, selected: 'api', waiting: 'api' });
  });

  it('ends the choice when the service stops, fails or is gone', () => {
    expect(resolvePreviewTarget([db, { ...api, state: 'stopped', url: undefined }, web], 'api')).toEqual({ target: web, lost: 'api' });
    expect(resolvePreviewTarget([db, { ...api, state: 'failed' }, web], 'api')).toEqual({ target: web, lost: 'api' });
    expect(resolvePreviewTarget([db, web], 'api')).toEqual({ target: web, lost: 'api' });
    expect(resolvePreviewTarget([db], 'api')).toEqual({ lost: 'api' });
  });

  it('never selects a database', () => {
    expect(resolvePreviewTarget(services, 'db')).toEqual({ target: web, lost: 'db' });
  });
});

describe('createPreviewSelection', () => {
  it('holds the choice across updates and reports a lost one until the next choice', () => {
    const selection = createPreviewSelection();
    expect(selection.resolve(services).target?.id).toBe('web');
    selection.select('api');
    expect(selection.resolve(services)).toEqual({ target: api });
    expect(selection.resolve(services)).toEqual({ target: api });
    // It stops (not a restart asked for here): back to the default, and the notice stays while it is down…
    const stopped = { ...api, state: 'stopped', url: undefined };
    expect(selection.resolve([db, stopped, web])).toEqual({ target: web, lost: 'api' });
    expect(selection.resolve([db, stopped, web])).toEqual({ target: web, lost: 'api' });
    // …and clears once it serves again (the choice stays ended: the default shows).
    expect(selection.resolve(services)).toEqual({ target: web });
  });

  it('a new choice clears the lost notice', () => {
    const selection = createPreviewSelection();
    selection.select('api');
    expect(selection.resolve([db, web])).toEqual({ target: web, lost: 'api' });
    selection.select('web');
    expect(selection.resolve([db, web])).toEqual({ target: web });
  });

  it('regression: Restart on the previewed service keeps the choice through stopping → stopped → starting → running', () => {
    const selection = createPreviewSelection();
    selection.select('api');
    expect(selection.resolve(services).target?.id).toBe('api');
    selection.holdThroughRestart('api');
    // An unrelated update before the restart takes effect keeps the hold.
    expect(selection.resolve(services)).toEqual({ target: api });
    for (const state of ['stopping', 'stopped', 'starting'] as const) {
      expect(selection.resolve([db, { ...api, state, url: undefined }, web])).toEqual({ target: web, waiting: 'api' });
    }
    expect(selection.resolve(services)).toEqual({ target: api });
    // The hold ended with the restart: a later stop ends the choice.
    expect(selection.resolve([db, { ...api, state: 'stopped', url: undefined }, web])).toEqual({ target: web, lost: 'api' });
  });

  it('a hold for another service changes nothing', () => {
    const selection = createPreviewSelection();
    selection.select('api');
    selection.resolve(services);
    selection.holdThroughRestart('web');
    expect(selection.resolve([db, { ...api, state: 'stopped', url: undefined }, web])).toEqual({ target: web, lost: 'api' });
  });

  it('a held restart that fails for good ends the choice', () => {
    const selection = createPreviewSelection();
    selection.select('api');
    selection.resolve(services);
    selection.holdThroughRestart('api');
    expect(selection.resolve([db, { ...api, state: 'stopped', url: undefined }, web])).toEqual({ target: web, waiting: 'api' });
    expect(selection.resolve([db, { ...api, state: 'failed', url: undefined, error: { willRestart: false } }, web])).toEqual({ target: web, lost: 'api' });
  });
});

describe('regression: a crash the runtime restarts', () => {
  it('failed with willRestart waits; without it the choice ends', () => {
    const crashed = { ...api, state: 'failed', url: undefined, error: { willRestart: true } };
    expect(resolvePreviewTarget([db, crashed, web], 'api')).toEqual({ target: web, selected: 'api', waiting: 'api' });
    expect(resolvePreviewTarget([db, { ...crashed, error: { willRestart: false } }, web], 'api')).toEqual({ target: web, lost: 'api' });
  });

  it('keeps the choice through failed(willRestart) → starting → running', () => {
    const selection = createPreviewSelection();
    selection.select('api');
    selection.resolve(services);
    expect(selection.resolve([db, { ...api, state: 'failed', url: undefined, error: { willRestart: true } }, web])).toEqual({ target: web, waiting: 'api' });
    expect(selection.resolve([db, { ...api, state: 'starting', url: undefined }, web])).toEqual({ target: web, waiting: 'api' });
    expect(selection.resolve(services)).toEqual({ target: api });
  });

  it('a held stop step waits in the pure resolver', () => {
    expect(resolvePreviewTarget([db, { ...api, state: 'stopped', url: undefined }, web], 'api', true)).toEqual({ target: web, selected: 'api', waiting: 'api' });
  });
});
