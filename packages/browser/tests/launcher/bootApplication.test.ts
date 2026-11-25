/**
 * The launcher page's boot wiring (`bootApplication.ts`) with the runtime mocked:
 * relay mode on the loopback origins, per-application origins from the template,
 * database Workers on the host origin, the .NET bundle when there is one, the files
 * written (binary decoded), every provider handed to the application runtime — and
 * the runtime disposed when anything after its boot fails.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaunchInfo, ProjectSnapshot } from '../../src/launcher/protocol.js';
import { bootApplication, runtimeOptionsFor, snapshotTree, type BootDeps } from '../../src/launcher/page/bootApplication.js';
import type { LaunchPlan } from '../../src/launcher/page/launchPlan.js';

const INFO: LaunchInfo = {
  projectId: 'p0123456789abcdef01234567',
  environment: null,
  manifestText: '{}',
  projectDir: '/p',
  manifestPath: '/p/.builderforce/builderforce.json',
  manifestSource: 'file',
  relayUrl: 'https://127.0.0.1:4000/__bfwc/relay.html',
  previewOriginTemplate: 'https://{key}.localhost:4000',
  hostWorkerUrl: 'https://localhost:4000/__bfwc/process-worker.js',
  dotnet: { bundleUrl: null, reason: 'none' },
};

const PLAN: Extract<LaunchPlan, { kind: 'ready' }> = {
  kind: 'ready',
  header: { name: 'x', environment: 'local', tier: 'non-production', target: 'browser' },
  spec: { projectId: INFO.projectId, services: [{ id: 'web', type: 'application', runtime: 'node', command: 'node server.js', port: 3000 }] },
  messages: [],
};

const SNAPSHOT: ProjectSnapshot = { files: { 'server.js': 'listen()' }, binary: { 'a.bin': Buffer.from([0, 255, 7]).toString('base64') }, skipped: [] };

function deps(overrides: Partial<BootDeps> = {}) {
  const runtime = { writeTree: vi.fn(), dispose: vi.fn(), fs: {} };
  const application = { start: vi.fn() };
  const origin = () => 'https://k.localhost:4000';
  const all: BootDeps = {
    startPreviewRuntime: vi.fn(async () => runtime as never),
    previewOriginTemplate: vi.fn(() => origin),
    startApplicationRuntime: vi.fn(() => application as never),
    providers: vi.fn(() => [{ id: 'node' } as never, { id: 'pglite' } as never]),
    phpOptions: { phpVersion: '8.3' },
    ...overrides,
  };
  return { all, runtime, application, origin };
}

describe('runtimeOptionsFor', () => {
  it('relay mode on loopback, per-application origins, the host worker, one PHP options object', () => {
    const { all, origin } = deps();
    const options = runtimeOptionsFor(INFO, all);
    expect(all.previewOriginTemplate).toHaveBeenCalledWith('https://{key}.localhost:4000');
    expect(options).toEqual({
      relayUrl: INFO.relayUrl,
      previewOrigin: origin,
      id: INFO.projectId,
      root: '/home/project',
      node: { workerUrl: INFO.hostWorkerUrl },
      php: all.phpOptions,
    });
    expect(options).not.toHaveProperty('sharedPreviewOrigin');
    expect(runtimeOptionsFor({ ...INFO, dotnet: { bundleUrl: 'https://127.0.0.1:4000/dotnet/' } }, all)).toMatchObject({ dotnet: { bundleUrl: 'https://127.0.0.1:4000/dotnet/' } });
    expect(options).not.toHaveProperty('page');
  });

  it('carries the page a launch asked for to the runtime', () => {
    const { all } = deps();
    expect(runtimeOptionsFor({ ...INFO, page: '/mockup.html' }, all)).toMatchObject({ page: '/mockup.html' });
  });
});

describe('bootApplication', () => {
  it('boots, writes the files (binary as bytes) and creates the application over every provider', async () => {
    const { all, runtime, application } = deps();
    const booted = await bootApplication(PLAN, INFO, SNAPSHOT, all);
    expect(booted).toEqual({ runtime, application });
    const tree = runtime.writeTree.mock.calls[0]![0] as Record<string, unknown>;
    expect(tree['server.js']).toBe('listen()');
    expect(Array.from(tree['a.bin'] as Uint8Array)).toEqual([0, 255, 7]);
    expect(all.providers).toHaveBeenCalledWith(runtime);
    expect(all.startApplicationRuntime).toHaveBeenCalledWith(PLAN.spec, { runtime, providers: [{ id: 'node' }, { id: 'pglite' }] });
    expect(application.start).not.toHaveBeenCalled(); // the page starts it, showing progress
  });

  it('disposes the runtime when creating the application fails', async () => {
    const { all, runtime } = deps({
      startApplicationRuntime: vi.fn(() => {
        throw new Error('no provider');
      }),
    });
    await expect(bootApplication(PLAN, INFO, SNAPSHOT, all)).rejects.toThrow('no provider');
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('snapshotTree keeps text as strings', () => {
    expect(snapshotTree({ files: { 'a.txt': 'é' }, binary: {}, skipped: ['x'] })).toEqual({ 'a.txt': 'é' });
  });
});
