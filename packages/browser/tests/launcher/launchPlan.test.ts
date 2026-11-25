/**
 * The launcher page's decisions before it boots anything (`launchPlan.ts`): no
 * manifest, a legacy file, a broken manifest, an unknown environment, declined
 * resources and .NET without its bundle — each to a blocked or ready plan with
 * its messages.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCHER_LABELS } from '../../src/launcher/labels.js';
import type { LaunchInfo } from '../../src/launcher/protocol.js';
import { defaultEnvironment, planLaunch, primaryServiceOf } from '../../src/launcher/page/launchPlan.js';

const labels = DEFAULT_LAUNCHER_LABELS;

function info(manifest: unknown, overrides: Partial<LaunchInfo> = {}): LaunchInfo {
  return {
    projectId: 'p0123456789abcdef01234567',
    environment: null,
    manifestText: manifest === null ? null : typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    projectDir: '/work/shop',
    manifestPath: '/work/shop/.builderforce/builderforce.json',
    manifestSource: manifest === null ? 'missing' : 'file',
    relayUrl: 'https://127.0.0.1:4000/__bfwc/relay.html',
    previewOriginTemplate: 'https://{key}.localhost:4000',
    hostWorkerUrl: 'https://localhost:4000/__bfwc/process-worker.js',
    dotnet: { bundleUrl: null, reason: 'not installed' },
    aiRelay: false,
    ...overrides,
  };
}

const web = { runtime: 'node', command: 'npm run dev', port: 5173, role: 'frontend' };

describe('planLaunch', () => {
  it('an http launcher: blocked before anything else, since the runtime runs applications only on https preview origins', () => {
    const plan = planLaunch(info(null, { relayUrl: 'http://127.0.0.1:4000/__bfwc/relay.html', previewOriginTemplate: 'http://{key}.localhost:4000' }), labels);
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'insecure', summary: labels.insecureLauncher });
  });

  it('regression: a canonical .builderforce/ manifest with no name is named after the project directory, never ".builderforce"', () => {
    for (const overrides of [
      { projectDir: '/work/shop', manifestPath: '/work/shop/.builderforce/builderforce.json', manifestSource: 'file' as const },
      { projectDir: 'C:\\work\\shop', manifestPath: 'C:\\work\\shop\\.builderforce\\builderforce.json', manifestSource: 'override' as const },
    ]) {
      const plan = planLaunch(info({ version: 1, services: { web } }, overrides), labels);
      expect(plan.header.name).toBe('shop');
    }
    expect(planLaunch(info(null, { projectDir: '/work/shop/' }), labels).header.name).toBe('shop');
  });

  it('a root manifest from an older version runs, with a visible notice to move it; one outside the project is an error', () => {
    const legacy = planLaunch(info({ version: 1, services: { web } }, { manifestSource: 'legacy', manifestPath: '/work/shop/builderforce.json', deprecation: 'x' }), labels);
    expect(legacy.kind).toBe('ready');
    expect(legacy.messages[0]).toEqual({ severity: 'warning', kind: 'issue', subject: '/work/shop/builderforce.json', text: labels.legacyManifestLocation.replace('{path}', '/work/shop/builderforce.json') });
    const custom = planLaunch(info({ version: 1, services: { web } }, { manifestSource: 'legacy' }), { ...labels, legacyManifestLocation: 'Bougez {path}' });
    expect(custom.messages[0]!.text).toBe('Bougez /work/shop/.builderforce/builderforce.json');
    const outside = planLaunch(info(null, { manifestOutside: true }), labels);
    expect(outside).toMatchObject({ kind: 'blocked', reason: 'outside', summary: labels.manifestOutsideProject.replace('{path}', '/work/shop/.builderforce/builderforce.json') });
    expect((outside as { summary: string }).summary).not.toContain('/manifest init');
    const unreadable = planLaunch(info(null, { manifestUnreadable: 'EACCES: permission denied' }), labels);
    expect(unreadable).toMatchObject({ kind: 'blocked', reason: 'unreadable', summary: 'The manifest at /work/shop/.builderforce/builderforce.json could not be read: EACCES: permission denied' });
    expect(planLaunch(info({ version: 1, services: { web } }), labels).messages).toEqual([]);
  });

  it('no manifest: blocked, pointing at /manifest init', () => {
    const plan = planLaunch(info(null), labels);
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'no-manifest', summary: labels.noManifest, header: { name: 'shop' } });
  });

  it('a legacy (unversioned) builderforce.json: blocked as an older format', () => {
    const plan = planLaunch(info({ services: [{ id: 'web' }] }), labels);
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'legacy', summary: 'This builderforce.json is an older format; run /manifest init.' });
    expect(plan.messages[0]).toMatchObject({ severity: 'info', kind: 'issue' });
  });

  it('unreadable JSON or another version: blocked as invalid, with the issue', () => {
    const broken = planLaunch(info('{ nope'), labels);
    expect(broken).toMatchObject({ kind: 'blocked', reason: 'invalid' });
    expect(broken.messages[0]?.text).toMatch(/not valid JSON/);
    expect(planLaunch(info({ version: 2 }), labels)).toMatchObject({ kind: 'blocked', reason: 'invalid' });
  });

  it('a manifest with errors: blocked, every issue listed with its path', () => {
    const plan = planLaunch(info({ version: 1, services: { web: { ...web, dependsOn: ['ghost'] } } }), labels);
    expect(plan.kind).toBe('blocked');
    expect(plan.messages.some((message) => message.severity === 'error' && message.subject?.startsWith('services.web'))).toBe(true);
  });

  it('an unknown environment: blocked', () => {
    const plan = planLaunch(info({ version: 1, services: { web } }, { environment: 'staging' }), labels);
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'invalid' });
    expect(plan.messages.length).toBeGreaterThan(0);
  });

  it('ready: the spec under the project id, the header from the manifest and environment', () => {
    const plan = planLaunch(info({ version: 1, name: 'Shop', services: { web } }), labels);
    expect(plan).toMatchObject({ kind: 'ready', header: { name: 'Shop', environment: 'local', tier: 'non-production', target: 'browser' } });
    if (plan.kind !== 'ready') throw new Error('not ready');
    expect(plan.spec.projectId).toBe('p0123456789abcdef01234567');
    expect(plan.spec.services.map((service) => service.id)).toEqual(['web']);
  });

  it('a resource the browser cannot host is a decline, and the app still runs without it', () => {
    const plan = planLaunch(info({ version: 1, resources: { cache: { type: 'redis' }, db: { type: 'postgres' } }, services: { web } }), labels);
    expect(plan.kind).toBe('ready');
    expect(plan.messages).toContainEqual(expect.objectContaining({ kind: 'declined', subject: 'cache', severity: 'warning' }));
    if (plan.kind === 'ready') expect(plan.spec.services.map((service) => service.id).sort()).toEqual(['db', 'web']);
  });

  it('.NET without the runtime bundle: blocked, each .NET service declined with the reason; with it: ready', () => {
    const manifest = { version: 1, services: { api: { runtime: 'dotnet', command: 'dotnet run', port: 5000 }, web } };
    const plan = planLaunch(info(manifest), labels);
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'declined', summary: labels.declinedServices });
    expect(plan.messages[0]).toEqual({ severity: 'error', kind: 'declined', subject: 'api', text: 'The .NET runtime bundle is not available: not installed' });
    expect(planLaunch(info(manifest, { dotnet: { bundleUrl: 'https://127.0.0.1:4000/dotnet/' } }), labels).kind).toBe('ready');
  });

  it('labels are injectable', () => {
    expect(planLaunch(info(null), { ...labels, noManifest: 'Kein Manifest.' })).toMatchObject({ summary: 'Kein Manifest.' });
  });
});

describe('defaultEnvironment', () => {
  it('picks the first browser environment, else the first, else local', () => {
    expect(defaultEnvironment({ version: 1, environments: { prod: { target: 'aws', tier: 'production' }, dev: { target: 'browser', tier: 'non-production' } } })).toBe('dev');
    expect(defaultEnvironment({ version: 1, environments: { prod: { target: 'aws', tier: 'production' } } })).toBe('prod');
    expect(defaultEnvironment({ version: 1 })).toBe('local');
  });
});

describe('primaryServiceOf', () => {
  it('the first frontend with a URL, else the first service with one', () => {
    expect(primaryServiceOf([{ id: 'api', url: 'a' }, { id: 'web', role: 'frontend', url: 'w' }])?.id).toBe('web');
    expect(primaryServiceOf([{ id: 'web', role: 'frontend' }, { id: 'api', url: 'a' }])?.id).toBe('api');
    expect(primaryServiceOf([{ id: 'db' }])).toBeUndefined();
  });
});
