/**
 * W10 telemetry (make.md › PRD 31 §4 W10, principle 6, design decision 9, the
 * Contract): every page-side refusal becomes a SecurityEvent in the bounded
 * ring and goes to the injected SecurityEventSink, attributed to the page-side
 * record of who acted — never a pid or identity a Worker's message claimed. A
 * throwing sink never changes a decision or breaks a request. Plus the
 * non-service-worker body limit (control 3) and routing on the scoped view (b).
 */
import { describe, expect, it } from 'vitest';
import { createChannelPair, PLATFORM_CONTEXT, textResponse, VirtualFileSystem, WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerToHost } from '../src/node/protocol.js';
import { NODE_ONLY, type ProcessKindPolicy } from '../src/node/processKinds.js';
import { processQuota } from '../src/node/processQuota.js';
import { createPgliteProvider } from '../src/app/pgliteProvider.js';
import { DEFAULT_MAX_BODY_BYTES } from '../src/swBody.js';
import {
  applicationContext,
  createShieldTelemetry,
  IngressLimit,
  MAX_EVIDENCE_BYTES,
  redactEvidence,
  SHIELD_RULES,
  type SecurityEvent,
  type SecurityEventSink,
  type ShieldTelemetry,
} from '../src/security.js';

const A: SecurityContext = { applicationId: 'app:a', serviceId: 'api' };
const B: SecurityContext = { applicationId: 'app:b', serviceId: 'api' };

interface Puppet {
  worker: WorkerLike;
  received: HostToWorker[];
  send(message: WorkerToHost | Record<string, unknown>): void;
}

function puppet(): Puppet {
  const p: Puppet = {
    received: [],
    worker: { onmessage: null, onerror: null, postMessage: (message) => void p.received.push(structuredClone(message) as HostToWorker), terminate: () => undefined },
    send: (message) => p.worker.onmessage?.({ data: message }),
  };
  return p;
}

function shieldHost(options: { sink?: SecurityEventSink; quota?: Parameters<typeof processQuota>[0]; maxBodyBytes?: number; kinds?: ProcessKindPolicy } = {}) {
  const fs = new VirtualFileSystem();
  fs.writeTree({ 'apps/a/server.js': 'a', 'apps/b/.env': 'B_SECRET=1', 'apps/b/tool': '#!/usr/bin/env node\n', 'package.json': '{}' });
  const telemetry = createShieldTelemetry({ sink: options.sink });
  const puppets: Puppet[] = [];
  const processes = new ProcessHost({
    fs,
    createWorker: () => {
      const p = puppet();
      puppets.push(p);
      return p.worker;
    },
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    previewUrl: 'https://app.test/__bfwc/p1/',
    warmWorker: false,
    kinds: options.kinds,
    security: { quota: processQuota(options.quota), telemetry, maxBodyBytes: options.maxBodyBytes },
  });
  return { fs, processes, puppets, telemetry };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const head = (p: Puppet, reqId: number) => p.received.find((m): m is Extract<HostToWorker, { type: 'response-head' }> => m.type === 'response-head' && m.reqId === reqId)?.head;

describe('the event ring and the sink', () => {
  it('maps a reason code to its rule, keeps the newest events up to the bound, and filters by application', () => {
    let t = 0;
    const telemetry = createShieldTelemetry({ capacity: 3, now: () => ++t });
    for (let i = 0; i < 5; i++) telemetry.report('port.not_owner', i % 2 ? A : B, { port: i });
    const events = telemetry.events();
    expect(events.map((e) => e.evidence.port)).toEqual([2, 3, 4]);
    expect(events[0]).toMatchObject({ category: 'network', ruleId: 'network.port-ownership', severity: 'medium', action: 'reject', reasonCode: 'port.not_owner', occurredAt: 3 });
    expect(telemetry.events({ applicationId: 'app:a' }).map((e) => e.evidence.port)).toEqual([3]);
    telemetry.decision(A, { allow: true });
    expect(telemetry.events()).toHaveLength(3); // an allow is not an event
  });

  it('defaults to a 500-event ring', () => {
    const telemetry = createShieldTelemetry();
    for (let i = 0; i < 600; i++) telemetry.report('fs.invalid_op', A);
    expect(telemetry.events()).toHaveLength(500);
  });

  it('a throwing or rejecting sink degrades telemetry health only; the ring keeps every event', async () => {
    const telemetry = createShieldTelemetry({ sink: { emit: () => { throw new Error('down'); } } });
    expect(() => telemetry.report('db.auth_failed', A)).not.toThrow();
    expect(telemetry.health()).toEqual({ enforcement: 'ok', telemetry: 'degraded', sinkFailures: 1 });
    expect(telemetry.events()).toHaveLength(1);

    const rejecting = createShieldTelemetry({ sink: { emit: () => Promise.reject(new Error('later')) as unknown as void } });
    rejecting.report('db.auth_failed', A);
    await tick();
    expect(rejecting.health()).toMatchObject({ enforcement: 'ok', telemetry: 'degraded', sinkFailures: 1 });
  });

  it('reports a refusal with no page-side owner as unattributed, and an application-wide one as that application', () => {
    const telemetry = createShieldTelemetry();
    telemetry.report('ingress.app_origin_mismatch', undefined, { port: 3000, origin: 'https://p.test' });
    telemetry.report('ingress.preview_origin_invalid', applicationContext('app:a'), { message: 'bad' });
    telemetry.report('ingress.shared_preview_origin', PLATFORM_CONTEXT);
    const [mismatch, invalid, shared] = telemetry.events();
    expect(mismatch).toMatchObject({ category: 'ingress', action: 'reject', context: { applicationId: 'unattributed' }, evidence: { port: 3000, origin: 'https://p.test' } });
    expect(invalid).toMatchObject({ action: 'reject', context: { applicationId: 'app:a', serviceId: 'unattributed' } });
    expect(shared).toMatchObject({ action: 'monitor', severity: 'low', context: { applicationId: 'platform' } });
  });

  it('every reason code has a rule', () => {
    for (const [code, rule] of Object.entries(SHIELD_RULES)) expect(rule.ruleId, code).toMatch(/^[a-z]+\.[a-z-]+$/);
  });
});

describe('evidence redaction', () => {
  it('never keeps secrets, bodies or objects, scrubs credentials out of strings, and stays within 4 KB', () => {
    const evidence = redactEvidence({
      password: 'hunter2',
      authorization: 'Bearer abc',
      cookie: 'sid=1',
      body: 'raw',
      token: 't',
      bytes: new Uint8Array(4),
      nested: { a: 1 },
      url: 'postgres://user:hunter2@localhost/db',
      header: 'Bearer sk-123 and api_key=xyz',
      port: 5432,
    });
    expect(evidence).toEqual({ url: 'postgres://[redacted]@localhost/db', header: 'Bearer [redacted] and api_key=[redacted]', port: 5432 });
    const big = redactEvidence(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'x'.repeat(2000)])));
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    expect(big.truncated).toBe(true);
  });
});

describe('events at the page-side chokepoints', () => {
  it('a file-system refusal is attributed to the Worker it arrived on, whatever pid the message claims', () => {
    const events: SecurityEvent[] = [];
    const { processes, puppets } = shieldHost({ sink: { emit: (e) => events.push(e) } });
    const victim = processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    const sender = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[1]!.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/.env', content: 'pwned' }, { op: 'nope', path: '/x' }], pid: victim.pid, identity: B });
    expect(events.map((e) => [e.reasonCode, e.category, e.context])).toEqual([
      ['fs.outside_app', 'filesystem', { ...A, processId: sender.pid }],
      ['fs.invalid_op', 'filesystem', { ...A, processId: sender.pid }],
    ]);
    expect(events[0]!.evidence).toEqual({ op: 'write', path: '/apps/b/.env' }); // never the content
  });

  it('a spawn over quota is reported as its application, with the parent pid from the page record', () => {
    const { processes, puppets, telemetry } = shieldHost({ quota: { maxProcesses: 1 } });
    const parent = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'spawn', childId: 1, command: 'node', args: [], pid: 999 });
    expect(telemetry.events()).toEqual([expect.objectContaining({ reasonCode: 'process.spawn_quota', category: 'resource', context: A, evidence: { live: 1, depth: 1, parentPid: parent.pid } })]);
  });

  it('a port refusal (loopback across applications) is reported as the page-side caller', async () => {
    const { processes, puppets, telemetry } = shieldHost();
    processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    const a = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'listen', port: 4000, id: 1 });
    puppets[1]!.send({ type: 'loopback', reqId: 1, port: 4000, request: { method: 'GET', url: '/', headers: {}, body: null }, pid: 1, identity: B });
    await tick();
    expect(telemetry.events()).toEqual([
      expect.objectContaining({ reasonCode: 'port.not_owner', category: 'network', context: { ...A, processId: a.pid }, evidence: { operation: 'request', port: 4000, ownerApplicationId: 'app:b', ownerServiceId: 'api' } }),
    ]);
  });

  it('a throwing sink does not break the refusal or the request', async () => {
    const { fs, processes, puppets, telemetry } = shieldHost({ sink: { emit: () => { throw new Error('sink down'); } } });
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/.env', content: 'pwned' }, { op: 'write', path: '/apps/a/ok.txt', content: 'ok' }] });
    expect(fs.readText('/apps/b/.env')).toBe('B_SECRET=1');
    expect(fs.readText('/apps/a/ok.txt')).toBe('ok');
    processes.ports.listen(5000, async () => textResponse(200, 'ok'));
    expect((await processes.request(5000, { method: 'GET', url: '/', headers: {}, body: null }))?.status).toBe(200);
    expect(telemetry.health().telemetry).toBe('degraded');
  });

  it('a database refusal is reported as the caller the port registry named, with the claimed name as evidence only', async () => {
    const telemetry = createShieldTelemetry();
    let accept: ((socket: ReturnType<typeof createChannelPair>[1], caller?: SecurityContext) => void) | undefined;
    const provider = createPgliteProvider({
      listenTcp: (port, handler) => ((accept = handler as typeof accept), { port, close: () => undefined }),
      createDatabaseWorker: () => ({ onmessage: null, postMessage: () => undefined, terminate: () => undefined }),
      security: () => telemetry,
    });
    const db = { id: 'db', type: 'database' as const, runtime: 'pglite', port: 5471, database: { engine: 'postgres', provider: 'pglite', persistent: false } };
    const handle = await provider.start(db, { env: {}, signal: new AbortController().signal, security: { applicationId: 'app:a', serviceId: 'db' } });
    void handle.output.cancel();
    const [client, server] = createChannelPair();
    accept!(server, A); // no login was issued to app:a/api
    client.send(startupMessage({ user: 'u', database: 'postgres', application_name: 'app:b/api' }));
    await tick();
    expect(telemetry.events()).toEqual([
      expect.objectContaining({ reasonCode: 'db.service_not_allowed', category: 'database', context: A, evidence: { database: 'postgres', claimedApplicationName: 'app:b/api' } }),
    ]);
    handle.kill();
  });
});

/** A Postgres v3 StartupMessage. */
function startupMessage(params: Record<string, string>): Uint8Array {
  const pairs = new TextEncoder().encode(Object.entries(params).map(([k, v]) => `${k}\0${v}\0`).join('') + '\0');
  const bytes = new Uint8Array(8 + pairs.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, bytes.length);
  view.setInt32(4, 196608);
  bytes.set(pairs, 8);
  return bytes;
}

describe('the request-body limit off the service worker (control 3)', () => {
  it("is the service worker's limit by default", () => {
    expect(new IngressLimit().maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it('answers an oversized loopback body 413 before the server sees it, reported as the sender', async () => {
    const { processes, puppets, telemetry } = shieldHost({ maxBodyBytes: 16 });
    const a = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    let served = 0;
    processes.ports.listen(6000, async () => (served++, textResponse(200, 'ok')));
    puppets[0]!.send({ type: 'loopback', reqId: 7, port: 6000, request: { method: 'POST', url: '/', headers: {}, body: new Uint8Array(17) } });
    await tick();
    expect(head(puppets[0]!, 7)?.status).toBe(413);
    expect(served).toBe(0);
    expect(telemetry.events()).toEqual([expect.objectContaining({ reasonCode: 'ingress.body_too_large', category: 'ingress', context: { ...A, processId: a.pid }, evidence: { path: 'loopback', port: 6000, method: 'POST', bytes: 17, limit: 16 } })]);
  });

  it('answers an oversized host-API body 413 (runtime.request), and lets one at the limit through', async () => {
    const { processes, telemetry } = shieldHost({ maxBodyBytes: 16 });
    processes.ports.listen(6001, async () => textResponse(200, 'ok'));
    const over = await processes.request(6001, { method: 'PUT', url: '/', headers: {}, body: new Uint8Array(17) });
    expect(over?.status).toBe(413);
    expect((await processes.requestStream(6001, { method: 'PUT', url: '/', headers: {}, body: new Uint8Array(17) }))?.status).toBe(413);
    expect((await processes.request(6001, { method: 'PUT', url: '/', headers: {}, body: new Uint8Array(16) }))?.status).toBe(200);
    expect(telemetry.events().map((e) => [e.reasonCode, e.context.applicationId, e.evidence.path])).toEqual([
      ['ingress.body_too_large', 'platform', 'host'],
      ['ingress.body_too_large', 'platform', 'host'],
    ]);
  });
});

describe('announced server URLs are assigned by the page', () => {
  it("ignores the Worker's URL: a registered port gets its page-side URL, anything else the runtime's preview URL", () => {
    const { processes, puppets } = shieldHost();
    const announced: Array<{ port: number; url: string }> = [];
    processes.servers.onListening((server) => void announced.push(server));
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'listen', port: 4100, id: 1 });
    announced.length = 0; // the port's own open
    puppets[0]!.send({ type: 'listening', port: 4100, url: 'https://evil.test/' });
    puppets[0]!.send({ type: 'listening', port: 5173, url: 'https://evil.test/' });
    puppets[0]!.send({ type: 'listening', port: -1, url: 'https://evil.test/' });
    expect(announced).toEqual([
      { port: 4100, url: processes.serverUrl(4100) },
      { port: 5173, url: 'https://app.test/__bfwc/p1/' },
    ]);
  });
});

describe('routing on the process view (finding b)', () => {
  it("an application process's command is routed on its view: another application's files are not there to read", () => {
    const seen: Array<[string, boolean, boolean]> = [];
    const kinds: ProcessKindPolicy = {
      ...NODE_ONLY,
      route: (command, args, { fs }) => (seen.push([command, fs.exists('/apps/b/tool'), fs.exists('/apps/a/server.js')]), { kind: 'node', command, args }),
    };
    const { processes } = shieldHost({ kinds });
    processes.spawnChild('/apps/b/tool', [], { identity: A, cwd: '/apps/a' });
    processes.spawnChild('/apps/b/tool', [], { identity: WORKSPACE_CONTEXT });
    expect(seen).toEqual([
      ['/apps/b/tool', false, true],
      ['/apps/b/tool', true, true],
    ]);
  });
});
