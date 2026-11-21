/**
 * The `node` provider against the real Node runtime (the core in-process
 * `Kernel`, which runs the same programs the browser's process workers do): a
 * Node API and a dependent Node service that calls it once it is ready.
 */
import { describe, expect, it } from 'vitest';
import { Kernel, defaultPrograms } from '@seanhogg/builderforce-webcontainers-core';
import { toApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/manifest';
import { acceptsNodeService, createNodeProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost, type ServiceLogEntry } from '../src/app.js';
import type { PreviewRuntime } from '../src/host.js';
import { stubRuntime, until } from './app-fakeProvider.js';

function kernel(files: Record<string, string>): Kernel {
  const k = new Kernel({ programs: defaultPrograms(), serverUrl: (port) => `https://app.test/__port/${port}/` });
  k.fs.writeTree(files);
  return k;
}

// Compile-time: a preview runtime IS a Node service host (`createNodeProvider(runtime)`).
export const previewRuntimeIsAHost = (runtime: PreviewRuntime): NodeServiceHost => runtime;

function nodeHost(processes: Kernel, direct = true): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    request: direct ? (port, request) => processes.request(port, { url: request.url }) : undefined,
    listProcesses: () => [{ ports: processes.ports.ports() }],
  };
}

const FILES = {
  'api/server.js': `
    const http = require('http');
    http.createServer((req, res) => {
      if (req.url === '/health') return res.end('ok');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [1, 2, 3], service: process.env.BUILDERFORCE_SERVICE }));
    }).listen(Number(process.env.PORT), () => console.log('api listening on ' + process.env.PORT));
  `,
  'web/server.js': `
    const http = require('http');
    fetch(process.env.API_URL + '/data').then((r) => r.json()).then((data) => {
      console.log('web got ' + JSON.stringify(data));
      http.createServer((req, res) => res.end('web')).listen(Number(process.env.PORT));
    });
  `,
};

const SPEC: ApplicationSpec = {
  projectId: 'proj-1',
  services: [
    { id: 'web', type: 'application', runtime: 'node', role: 'frontend', root: '/web', command: 'node', args: ['server.js'], port: 3000, dependsOn: ['api'] },
    { id: 'api', type: 'application', runtime: 'node', root: '/api', command: 'node', args: ['server.js'], port: 8000, readiness: { kind: 'http', path: '/health' } },
  ],
};

async function collect(stream: ReadableStream<ServiceLogEntry>, until: (entries: ServiceLogEntry[]) => boolean): Promise<ServiceLogEntry[]> {
  const reader = stream.getReader();
  const entries: ServiceLogEntry[] = [];
  while (!until(entries)) {
    const { value, done } = await reader.read();
    if (done) break;
    entries.push(value);
  }
  await reader.cancel();
  return entries;
}

describe('node provider', () => {
  it('declines what it cannot run, with a reason', () => {
    expect(acceptsNodeService({ id: 'db', type: 'database', runtime: 'node', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: true } })).toEqual({
      ok: false,
      reason: 'The node runtime runs application services; "db" is a database service.',
    });
    expect(acceptsNodeService({ id: 'edge', type: 'application', runtime: 'node', command: 'npx', args: ['wrangler', 'dev'], port: 8787 })).toMatchObject({ ok: false, reason: expect.stringContaining('wrangler dev') });
    expect(acceptsNodeService({ id: 'q', type: 'application', runtime: 'node', command: 'node', port: 1, readiness: { kind: 'query' } })).toMatchObject({ ok: false });
    expect(acceptsNodeService(SPEC.services[0]!)).toEqual({ ok: true });
  });

  it('regression: declines a declined program inside a manifest command line, shell line or not', () => {
    const serviceOf = (command: string) => {
      const { spec } = toApplicationSpec({ version: 1, services: { app: { runtime: 'node', command } } }, 'local', { projectId: 'p' });
      return spec!.services[0]!;
    };
    // Plain words split into program + args.
    expect(serviceOf('docker compose up')).toMatchObject({ command: 'docker', args: ['compose', 'up'] });
    expect(acceptsNodeService(serviceOf('docker compose up'))).toMatchObject({ ok: false, reason: expect.stringContaining('Docker') });
    // A shell line is one `-c` argument: each command in it is checked.
    expect(serviceOf('cd infra && docker compose up')).toMatchObject({ command: 'bfsh', args: ['-c', 'cd infra && docker compose up'] });
    expect(acceptsNodeService(serviceOf('cd infra && docker compose up'))).toMatchObject({ ok: false, reason: expect.stringContaining('Docker') });
    expect(acceptsNodeService(serviceOf('WRANGLER_LOG=debug wrangler dev'))).toMatchObject({ ok: false, reason: expect.stringContaining('wrangler dev') });
    expect(acceptsNodeService(serviceOf('npm install && npm run dev > dev.log'))).toEqual({ ok: true });
  });

  it('regression: unwraps sh/bash -c lines and command substitutions before the decline check', () => {
    const app = (command: string, args: string[]) => ({ id: 'app', type: 'application' as const, runtime: 'node', command, args });
    expect(acceptsNodeService(app('sh', ['-c', 'docker compose up']))).toMatchObject({ ok: false, reason: expect.stringContaining('Docker') });
    expect(acceptsNodeService(app('/bin/bash', ['-e', '-c', 'cd infra && wrangler dev']))).toMatchObject({ ok: false, reason: expect.stringContaining('wrangler dev') });
    expect(acceptsNodeService(app('bfsh', ['-c', 'echo $(docker compose up)']))).toMatchObject({ ok: false, reason: expect.stringContaining('Docker') });
    expect(acceptsNodeService(app('bfsh', ['-c', 'echo `docker ps`']))).toMatchObject({ ok: false });
    expect(acceptsNodeService(app('bfsh', ['-c', "sh -c 'bash -c \"docker compose up\"'"]))).toMatchObject({ ok: false });
    expect(acceptsNodeService(app('sh', ['-c', 'npm install && npm run dev']))).toEqual({ ok: true });
  });

  it('runs an API and a dependent service that calls it after readiness; stops both in reverse order', async () => {
    const processes = kernel(FILES);
    const runtime = startApplicationRuntime(SPEC, { runtime: stubRuntime(), providers: [createNodeProvider(nodeHost(processes), { probeIntervalMs: 20 })], readinessTimeoutMs: 20_000 });
    const changes: string[] = [];
    runtime.onStateChange(({ serviceId, to }) => changes.push(`${serviceId}:${to}`));

    await runtime.start();
    expect(runtime.getService('api')?.state).toBe('running');
    expect(runtime.getService('web')?.state).toBe('running');
    // The dependent started only after the API answered its health URL.
    expect(changes.indexOf('web:preparing')).toBeLessThan(changes.indexOf('api:running'));
    expect(changes.indexOf('web:starting')).toBeGreaterThan(changes.indexOf('api:running'));
    expect(runtime.getUrl('api')).toBe('https://app.test/__port/8000/');
    expect(runtime.getUrl('web')).toBe('https://app.test/__port/3000/');

    const logs = await collect(runtime.logs(), (entries) => entries.some((e) => e.text.startsWith('web got')));
    expect(logs.find((e) => e.serviceId === 'api')?.text).toBe('api listening on 8000');
    expect(logs.find((e) => e.serviceId === 'web')?.text).toBe('web got {"items":[1,2,3],"service":"api"}');

    changes.length = 0;
    await runtime.stop();
    expect(changes).toEqual(['web:stopping', 'web:stopped', 'api:stopping', 'api:stopped']);
    expect(runtime.getService('api')?.exitCode).toBe(143);
    expect(processes.ports.has(8000)).toBe(false);
    expect(processes.ports.has(3000)).toBe(false);
  }, 30_000);

  it('restarts the API alone; the dependent keeps running', async () => {
    const processes = kernel(FILES);
    const runtime = startApplicationRuntime(SPEC, { runtime: stubRuntime(), providers: [createNodeProvider(nodeHost(processes), { probeIntervalMs: 20 })], readinessTimeoutMs: 20_000 });
    await runtime.start();
    const changes: string[] = [];
    runtime.onStateChange(({ serviceId, to }) => changes.push(`${serviceId}:${to}`));
    await runtime.restart('api');
    expect(changes).toEqual(['api:stopping', 'api:stopped', 'api:preparing', 'api:starting', 'api:ready', 'api:running']);
    expect(runtime.getService('web')?.state).toBe('running');
    expect((await processes.request(8000, { url: '/health' }))?.status).toBe(200);
    expect((await processes.request(3000, { url: '/' }))?.status).toBe(200);
    await runtime.stop();
  }, 30_000);

  it('probes http readiness from inside the runtime when the host has no direct request', async () => {
    const processes = kernel(FILES);
    const api = SPEC.services[1]!;
    const runtime = startApplicationRuntime({ projectId: 'p', services: [api] }, { runtime: stubRuntime(), providers: [createNodeProvider(nodeHost(processes, false), { probeIntervalMs: 20 })], readinessTimeoutMs: 20_000 });
    await runtime.start();
    expect(runtime.getService('api')?.state).toBe('running');
    await runtime.stop();
  }, 30_000);

  it('fails at once, not after the readiness timeout, when another process still holds the port', async () => {
    const processes = kernel(FILES);
    const stale = processes.run('node', ['server.js'], { cwd: '/api', env: { PORT: '8000' } });
    await until(() => processes.ports.has(8000));
    const runtime = startApplicationRuntime(
      { projectId: 'p', services: [{ ...SPEC.services[1]!, restartPolicy: 'never' }] },
      { runtime: stubRuntime(), providers: [createNodeProvider(nodeHost(processes))], readinessTimeoutMs: 20_000 },
    );
    const began = Date.now();
    await expect(runtime.start()).rejects.toMatchObject({ failures: [{ serviceId: 'api', phase: 'start', message: 'Port 8000 is already in use by another process.' }] });
    expect(Date.now() - began).toBeLessThan(5_000);
    stale.kill();
    await stale.wait();
  }, 30_000);

  it('fails a service that exits before it is ready, with its exit code', async () => {
    const processes = kernel({ 'boom.js': 'console.error("boom"); process.exit(3);' });
    const runtime = startApplicationRuntime(
      { projectId: 'p', services: [{ id: 'api', type: 'application', runtime: 'node', command: 'node', args: ['boom.js'], port: 8000, restartPolicy: 'never' }] },
      { runtime: stubRuntime(), providers: [createNodeProvider(nodeHost(processes))] },
    );
    await expect(runtime.start()).rejects.toMatchObject({ failures: [{ serviceId: 'api', phase: 'exit', exitCode: 3 }] });
    await until(() => runtime.getService('api')?.state === 'failed');
  }, 30_000);
});
