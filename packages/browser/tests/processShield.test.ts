/**
 * Security Shield controls 8 and 9 on the page side of the process host
 * (make.md › PRD 31 §4 W10): identity assigned at spawn and inherited, spawn
 * quotas, attribution of detached children, and per-application file-system
 * views. Most processes here are puppets — Workers the test speaks for — so a
 * hostile Worker's messages can be sent as-is.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_CONTEXT,
  VirtualFileSystem,
  WORKSPACE_CONTEXT,
  mountSnapshot,
  type CodeScanner,
  type SecurityContext,
  type ShieldDecision,
  type VfsSnapshot,
} from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerToHost } from '../src/node/protocol.js';
import { processQuota } from '../src/node/processQuota.js';
import { fakeWorker, readAll } from './helpers.js';

interface Puppet {
  worker: WorkerLike;
  received: HostToWorker[];
  alive: boolean;
  send(message: WorkerToHost | Record<string, unknown>): void;
}

function puppet(): Puppet {
  const p: Puppet = {
    received: [],
    alive: true,
    worker: {
      onmessage: null,
      onerror: null,
      postMessage: (message) => {
        p.received.push(structuredClone(message) as HostToWorker);
        // A spare acknowledges its prime, as a real Worker does once the file system is mounted.
        if ((message as HostToWorker).type === 'prime') queueMicrotask(() => p.worker.onmessage?.({ data: { type: 'primed' } }));
      },
      terminate: () => void (p.alive = false),
    },
    send: (message) => p.worker.onmessage?.({ data: message }),
  };
  return p;
}

const A: SecurityContext = { applicationId: 'app:a', serviceId: 'api' };
const B: SecurityContext = { applicationId: 'app:b', serviceId: 'api' };

const FILES = {
  'apps/a/server.js': 'a',
  'apps/a/.env': 'A_SECRET=1',
  'apps/b/.env': 'B_SECRET=1',
  'node_modules/lib/index.js': 'module.exports = 1',
  'package.json': '{}',
  '.bfwc/attribution-off': '',
};

function shieldHost(options: { quota?: Parameters<typeof processQuota>[0]; real?: boolean; warm?: boolean; files?: Record<string, string>; scanner?: CodeScanner } = {}) {
  const fs = new VirtualFileSystem();
  fs.writeTree({ ...FILES, ...options.files });
  const puppets: Puppet[] = [];
  const decisions: Array<[SecurityContext, ShieldDecision]> = [];
  const createWorker = (): WorkerLike => {
    if (options.real) return fakeWorker();
    const p = puppet();
    puppets.push(p);
    return p.worker;
  };
  const processes = new ProcessHost({
    fs,
    createWorker,
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    packageCache: !options.real,
    warmWorker: !!options.warm,
    security: { quota: processQuota(options.quota), onDecision: (context, decision) => decisions.push([context, decision]), scanner: options.scanner },
  });
  return { fs, processes, puppets, decisions };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const startOf = (p: Puppet) => p.received.find((m): m is Extract<HostToWorker, { type: 'start' }> => m.type === 'start')!;
const fsOps = (p: Puppet) => p.received.flatMap((m) => (m.type === 'fs' ? m.ops.map((op) => op.path) : []));
const mounted = (p: Puppet) => {
  const mirror = new VirtualFileSystem();
  mountSnapshot(mirror, startOf(p).snapshot as VfsSnapshot);
  return mirror;
};

describe('process identity', () => {
  it('a page-side start carries the identity given, and none is workspace', () => {
    const { processes } = shieldHost();
    const app = processes.spawnChild('node', ['server.js'], { identity: A, cwd: '/apps/a' });
    const terminal = processes.spawnChild('bfsh');
    expect(processes.identityOf(app.pid)).toEqual({ ...A, processId: app.pid });
    expect(processes.identityOf(terminal.pid)).toEqual({ ...WORKSPACE_CONTEXT, processId: terminal.pid });
  });

  it('no process can be platform', () => {
    const { processes } = shieldHost();
    expect(() => processes.spawnChild('node', [], { identity: PLATFORM_CONTEXT })).toThrow(/platform/);
  });

  it("a child inherits its parent's identity, whatever the Worker's message claims", async () => {
    const { processes, puppets } = shieldHost();
    const parent = processes.spawnChild('node', ['server.js'], { identity: A, cwd: '/apps/a' });
    // Forged: a spawn message has no `identity`; the cast keeps the hostile payload as sent.
    puppets[0]!.send({ type: 'spawn', childId: 1, command: 'node', args: [], cwd: '/apps/b', env: { BUILDERFORCE_SERVICE: 'web' }, identity: PLATFORM_CONTEXT } as unknown as WorkerToHost);
    puppets[0]!.send({ type: 'spawn', childId: 2, command: 'node', args: [], identity: B } as unknown as WorkerToHost);
    const children = processes.list().filter((info) => info.pid !== parent.pid);
    expect(children).toHaveLength(2);
    for (const child of children) expect(processes.identityOf(child.pid)).toEqual({ ...A, processId: child.pid });
    // The child's view is its parent's: rooted at /apps/a even though it asked for /apps/b as its cwd.
    expect(mounted(puppets[1]!).exists('/apps/b/.env')).toBe(false);
    expect(mounted(puppets[1]!).readText('/apps/a/.env')).toBe('A_SECRET=1');
  });
});

describe('attribution follows the Worker a message arrived on', () => {
  it('a forged pid or identity in listen, loopback, dial or fs messages is attributed to the real sender', async () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    const victim = processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    const sender = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const owners: unknown[] = [];
    const callers: unknown[] = [];
    const ports = processes.ports as unknown as Record<string, (...args: unknown[]) => unknown>;
    const listen = ports.listen!.bind(processes.ports);
    const request = ports.request!.bind(processes.ports);
    ports.listen = (...args) => (owners.push(args[4]), listen(...args));
    ports.request = (...args) => (callers.push(args[2]), request(...args));
    const forged = { pid: victim.pid, processId: victim.pid, identity: B, applicationId: B.applicationId, serviceId: B.serviceId };
    const a = puppets[1]!;
    a.send({ type: 'listen', port: 3000, id: 1, ...forged });
    a.send({ type: 'loopback', reqId: 1, port: 3000, request: { method: 'GET', url: '/', headers: {}, body: null }, ...forged });
    a.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/.env', content: 'pwned' }], ...forged });
    a.send({ type: 'spawn', childId: 1, command: 'node', args: [], ...forged });
    await tick();
    const real = { ...A, processId: sender.pid };
    expect(owners).toEqual([real]);
    expect(callers).toEqual([real]);
    expect(fs.readText('/apps/b/.env')).toBe('B_SECRET=1');
    expect(decisions).toEqual([[real, { allow: false, reason: 'fs.outside_app' }]]);
    const child = processes.list().find((info) => info.pid !== victim.pid && info.pid !== sender.pid)!;
    expect(processes.identityOf(child.pid)).toEqual({ ...A, processId: child.pid });
  });
});

describe('process quotas (control 9)', () => {
  it('refuses a spawn past the application process count with EAGAIN, other applications unaffected', async () => {
    const { processes, puppets, decisions } = shieldHost({ quota: { maxProcesses: 2 } });
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'spawn', childId: 1, command: 'node', args: [] });
    puppets[0]!.send({ type: 'spawn', childId: 2, command: 'node', args: [] });
    expect(puppets[0]!.received).toContainEqual(expect.objectContaining({ type: 'child-error', childId: 2, code: 'EAGAIN' }));
    expect(() => processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' })).toThrow(expect.objectContaining({ code: 'EAGAIN', reason: 'process.spawn_quota' }));
    expect(() => processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' })).not.toThrow();
    expect(() => processes.spawnChild('node', [])).not.toThrow(); // workspace is not an application
    expect(decisions.map(([context, decision]) => [context.applicationId, decision])).toEqual([
      ['app:a', { allow: false, reason: 'process.spawn_quota' }],
      ['app:a', { allow: false, reason: 'process.spawn_quota' }],
    ]);
  });

  it('refuses a spawn deeper than the application depth quota', () => {
    const { processes, puppets, decisions } = shieldHost({ quota: { maxDepth: 1 } });
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'spawn', childId: 1, command: 'node', args: [] }); // depth 1
    puppets[1]!.send({ type: 'spawn', childId: 1, command: 'node', args: [] }); // depth 2
    expect(puppets).toHaveLength(2);
    expect(puppets[1]!.received).toContainEqual(expect.objectContaining({ type: 'child-error', childId: 1, code: 'EAGAIN' }));
    expect(decisions).toEqual([[{ applicationId: 'app:a', serviceId: 'api' }, { allow: false, reason: 'process.depth_quota' }]]);
  });

  it('an exited process frees its place in the quota', async () => {
    const { processes, puppets } = shieldHost({ quota: { maxProcesses: 1 } });
    const first = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({ type: 'exit', code: 0 });
    await first.exit;
    expect(() => processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' })).not.toThrow();
  });
});

describe('attribution (control 9)', () => {
  it('a detached child outlives its parent but not killApplication', async () => {
    const { processes, puppets } = shieldHost();
    const parent = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const other = processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    puppets[0]!.send({ type: 'spawn', childId: 1, command: 'node', args: [], detached: true });
    const detached = puppets[2]!;
    puppets[0]!.send({ type: 'exit', code: 0 });
    await parent.exit;
    await tick();
    expect(detached.alive).toBe(true);
    const child = processes.list().find((info) => info.pid !== other.pid)!;
    expect(processes.identityOf(child.pid)?.applicationId).toBe('app:a');

    processes.killApplication('app:a');
    expect(detached.alive).toBe(false);
    expect(processes.list().map((info) => info.pid)).toEqual([other.pid]);
    expect(puppets[1]!.alive).toBe(true);
  });

  it('killApplication with a service ends only that service', () => {
    const { processes, puppets } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    processes.spawnChild('node', [], { identity: { applicationId: 'app:a', serviceId: 'web' }, cwd: '/apps/a' });
    processes.killApplication('app:a', 'web');
    expect(puppets.map((p) => p.alive)).toEqual([true, false]);
  });
});

describe('file-system views (control 8)', () => {
  it("an application's snapshot holds its service directory and the shared, read-only paths — never another application's", () => {
    const { processes, puppets } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const mirror = mounted(puppets[0]!);
    expect(mirror.list()).toEqual(['/.bfwc/attribution-off', '/apps/a/.env', '/apps/a/server.js', '/node_modules/lib/index.js', '/package.json']);
  });

  it("an application never receives another application's writes; the workspace receives everything", async () => {
    const { fs, processes, puppets } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    processes.spawnChild('bfsh');
    const [a, b, workspace] = puppets as [Puppet, Puppet, Puppet];
    b.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/creds.json', content: '{"token":"x"}' }] });
    fs.writeFile('/apps/b/.env', 'B_SECRET=2');
    fs.writeFile('/apps/a/shared.txt', 'for a');
    await tick();
    expect(fs.readText('/apps/b/creds.json')).toBe('{"token":"x"}');
    expect(fsOps(a)).toEqual(['/apps/a/shared.txt']);
    expect(fsOps(b)).toEqual(['/apps/b/.env']);
    expect(fsOps(workspace)).toEqual(['/apps/b/creds.json', '/apps/b/.env', '/apps/a/shared.txt']);
  });

  it('refuses an application write outside its service directory, and to platform paths', async () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    puppets[0]!.send({
      type: 'fs',
      ops: [
        { op: 'write', path: '/apps/b/.env', content: 'pwned' },
        { op: 'write', path: '/apps/a/../b/x.js', content: 'pwned' },
        { op: 'write', path: '/node_modules/lib/index.js', content: 'pwned' },
        { op: 'write', path: '/.bfwc/attribution-off', content: 'pwned' },
        { op: 'remove', path: '/' },
        { op: 'write', path: '/apps/a/out.txt', content: 'ok' },
      ],
    });
    expect(fs.readText('/apps/b/.env')).toBe('B_SECRET=1');
    expect(fs.exists('/apps/b/x.js')).toBe(false);
    expect(fs.readText('/node_modules/lib/index.js')).toBe('module.exports = 1');
    expect(fs.readText('/.bfwc/attribution-off')).toBe('');
    expect(fs.readText('/apps/a/out.txt')).toBe('ok');
    expect(decisions.map(([context, decision]) => [context.applicationId, decision.allow ? 'allow' : decision.reason])).toEqual([
      ['app:a', 'fs.outside_app'],
      ['app:a', 'fs.outside_app'],
      ['app:a', 'fs.protected_path'],
      ['app:a', 'fs.protected_path'],
      ['app:a', 'fs.protected_path'],
    ]);
  });

  it('refuses an op that is not exactly one of the journal kinds (H1): an unknown op never becomes a remove', async () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/' });
    processes.spawnChild('bfsh');
    for (const p of puppets) {
      // Forged: malformed journal ops; the cast keeps the payload as sent.
      p.send({
        type: 'fs',
        ops: [{ op: 'x', path: '/' }, { op: 'write', path: '/a.txt', content: 42 }, { op: 'remove', path: 7 }, null, { op: 'write', path: '/ok.txt', content: 'ok' }],
      } as unknown as WorkerToHost);
    }
    expect(fs.list()).toEqual(['/.bfwc/attribution-off', '/apps/a/.env', '/apps/a/server.js', '/apps/b/.env', '/node_modules/lib/index.js', '/ok.txt', '/package.json']);
    expect(decisions.map(([context, d]) => [context.applicationId, d.allow ? 'allow' : d.reason])).toEqual([
      ...Array(4).fill(['app:a', 'fs.invalid_op']),
      ...Array(4).fill(['workspace', 'fs.invalid_op']),
    ]);
  });

  it('keeps shared dependencies and platform paths read-only to a service rooted at the workspace (H2)', () => {
    const { fs, processes, puppets, decisions } = shieldHost({ files: { 'tsconfig.json': '{}', 'tsconfig.base.json': '{}' } });
    processes.spawnChild('node', [], { identity: A, cwd: '/' });
    puppets[0]!.send({
      type: 'fs',
      ops: [
        { op: 'write', path: '/node_modules/lib/index.js', content: 'pwned' },
        { op: 'write', path: '/tsconfig.json', content: 'pwned' },
        { op: 'remove', path: '/node_modules' },
        { op: 'remove', path: '/.bfwc' },
        { op: 'write', path: '/apps/a/ok.txt', content: 'ok' },
      ],
    });
    expect(fs.readText('/node_modules/lib/index.js')).toBe('module.exports = 1');
    expect(fs.readText('/tsconfig.json')).toBe('{}');
    expect(fs.exists('/.bfwc/attribution-off')).toBe(true);
    expect(fs.readText('/apps/a/ok.txt')).toBe('ok');
    expect(decisions.map(([, d]) => (d.allow ? 'allow' : d.reason))).toEqual(['fs.protected_path', 'fs.protected_path', 'fs.protected_path', 'fs.protected_path']);
  });

  it("a service rooted above another service's directory may not write into it, nor read another application's (H2)", () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    processes.spawnChild('node', [], { identity: B, cwd: '/apps/b' });
    processes.spawnChild('node', [], { identity: { applicationId: 'app:a', serviceId: 'api' }, cwd: '/apps/a' });
    processes.spawnChild('node', [], { identity: { applicationId: 'app:a', serviceId: 'web' }, cwd: '/' });
    const web = puppets[2]!;
    expect(mounted(web).exists('/apps/b/.env')).toBe(false); // another application's
    expect(mounted(web).readText('/apps/a/.env')).toBe('A_SECRET=1'); // its own application's sibling: readable
    web.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/a/.env', content: 'x' }, { op: 'write', path: '/apps/b/.env', content: 'x' }, { op: 'remove', path: '/apps' }, { op: 'mkdir', path: '/apps/c' }] });
    expect(fs.readText('/apps/a/.env')).toBe('A_SECRET=1');
    expect(fs.readText('/apps/b/.env')).toBe('B_SECRET=1');
    expect(fs.isDirectory('/apps/c')).toBe(true);
    expect(decisions.map(([, d]) => (d.allow ? 'allow' : d.reason))).toEqual(['fs.outside_app', 'fs.outside_app', 'fs.outside_app']);
  });

  it('shares root tsconfig*.json read-only, and never .npmrc or .env* (M3)', () => {
    const { processes, puppets } = shieldHost({ files: { 'tsconfig.json': '{}', 'tsconfig.base.json': '{}', '.npmrc': '//registry/:_authToken=x', '.env': 'ROOT=1', '.env.local': 'L=1' } });
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const mirror = mounted(puppets[0]!);
    expect(mirror.exists('/tsconfig.json') && mirror.exists('/tsconfig.base.json')).toBe(true);
    expect([mirror.exists('/.npmrc'), mirror.exists('/.env'), mirror.exists('/.env.local')]).toEqual([false, false, false]);
  });

  it("sends the sender the page's truth for what it refused, so its mirror does not diverge (M3)", async () => {
    const { processes, puppets } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const a = puppets[0]!;
    a.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/.env', content: 'x' }, { op: 'write', path: '/package.json', content: 'x' }, { op: 'write', path: '/node_modules/evil.js', content: 'x' }] });
    await tick();
    const sent = a.received.flatMap((m) => (m.type === 'fs' ? m.ops : []));
    expect(sent).toEqual([
      { op: 'remove', path: '/apps/b/.env' },
      { op: 'write', path: '/package.json', content: '{}' },
      { op: 'remove', path: '/node_modules/evil.js' },
    ]);
  });

  it('drops a mkdir above the service directory without applying or broadcasting it (L2)', async () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    processes.spawnChild('bfsh');
    puppets[0]!.send({ type: 'fs', ops: [{ op: 'mkdir', path: '/apps' }] });
    await tick();
    expect(fs.explicitDirectories()).not.toContain('/apps');
    expect(fsOps(puppets[1]!)).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it('turns the shared package cache off for application processes (H4)', () => {
    const { processes, puppets } = shieldHost();
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    processes.spawnChild('bfsh');
    expect(puppets.map((p) => startOf(p).packageCache)).toEqual([false, true]);
  });
});

describe('after a process exited (M1)', () => {
  it('a late fs or listen message from its Worker is ignored', async () => {
    const { fs, processes, puppets } = shieldHost();
    const app = processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const terminal = processes.spawnChild('bfsh');
    for (const p of puppets) p.send({ type: 'exit', code: 0 });
    await Promise.all([app.exit, terminal.exit]);
    for (const p of puppets) {
      p.send({ type: 'fs', ops: [{ op: 'write', path: '/apps/b/.env', content: 'late' }] });
      p.send({ type: 'listen', port: 4000, id: 1 });
    }
    expect(fs.readText('/apps/b/.env')).toBe('B_SECRET=1');
    expect(processes.ports.has(4000)).toBe(false);
  });
});

describe('view snapshots (M4)', () => {
  it("a service's next process starts warm from its view's spare, with only the visible changes since", async () => {
    const { fs, processes, puppets } = shieldHost({ warm: true });
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    await new Promise((resolve) => setTimeout(resolve, 5)); // the view's spare is primed off the spawn's path
    const spare = puppets.find((p) => p.received[0]?.type === 'prime')!;
    const primed = new VirtualFileSystem();
    mountSnapshot(primed, (spare.received[0] as Extract<HostToWorker, { type: 'prime' }>).snapshot);
    expect(primed.exists('/apps/b/.env')).toBe(false);
    fs.writeFile('/apps/a/new.txt', 'visible');
    fs.writeFile('/apps/b/new.txt', 'hidden');
    processes.spawnChild('node', [], { identity: A, cwd: '/apps/a' });
    const start = startOf(spare);
    expect(start.snapshot.pack).toBeUndefined();
    expect(start.snapshot.ops.map((op) => op.path)).toEqual(['/apps/a/new.txt']);
  });
});

describe('workspace and real processes', () => {
  it('a workspace process keeps the full view and may write anywhere', async () => {
    const { fs, processes, puppets, decisions } = shieldHost();
    processes.spawnChild('bfsh');
    expect(mounted(puppets[0]!).list()).toEqual(['/.bfwc/attribution-off', '/apps/a/.env', '/apps/a/server.js', '/apps/b/.env', '/node_modules/lib/index.js', '/package.json']);
    puppets[0]!.send({ type: 'fs', ops: [{ op: 'write', path: '/.bfwc/marker', content: '1' }, { op: 'write', path: '/apps/b/.env', content: 'edited' }] });
    expect(fs.readText('/.bfwc/marker')).toBe('1');
    expect(fs.readText('/apps/b/.env')).toBe('edited');
    expect(decisions).toEqual([]);
  });

  it('a real Node process of an application cannot read another application’s file', async () => {
    const { processes } = shieldHost({ real: true });
    const proc = processes.run('node', ['-e', `const fs = require('fs'); console.log(fs.existsSync('/apps/b/.env'), fs.readFileSync('/apps/a/.env', 'utf8'))`], { identity: A, cwd: '/apps/a' });
    expect(await readAll(proc.combinedOutput)).toBe('false A_SECRET=1\n');
    expect(await proc.wait()).toBe(0);
  });
});

describe('code scanner', () => {
  /** Blocks any file whose content says EVIL; everything else is clean. */
  const scanner: CodeScanner = {
    scan: async (_origin, subjects) =>
      subjects.map((s) => ({ path: s.path, action: s.content === 'EVIL' ? 'block' : 'allow', complete: true, score: 90, ruleIds: ['signature.eicar'] })),
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const blocked = (decisions: Array<[SecurityContext, ShieldDecision]>) => decisions.filter(([, d]) => !d.allow && d.reason === 'code.blocked');

  it('reports a written file the scanner blocks once, refuses to spawn it, and unblocks it when rewritten', async () => {
    const { processes, puppets, decisions } = shieldHost({ scanner });
    processes.spawnChild('node', []);
    puppets[0]!.send({ type: 'fs', ops: [{ op: 'write', path: '/evil.js', content: 'EVIL' }] });
    await settle();
    expect(blocked(decisions)).toHaveLength(1);
    expect(() => processes.spawnChild('node', ['evil.js'])).toThrow(/code\.blocked/);
    puppets[0]!.send({ type: 'fs', ops: [{ op: 'write', path: '/evil.js', content: 'fine' }] });
    expect(() => processes.spawnChild('node', ['evil.js'])).not.toThrow();
    await settle();
    // The write's verdict and the refused spawn are two decisions; the clean rewrite adds none.
    expect(blocked(decisions)).toHaveLength(2);
  });

  it('answers a process scan request through the page scanner and reports a blocked package', async () => {
    const { processes, puppets, decisions } = shieldHost({ scanner });
    processes.spawnChild('node', []);
    puppets[0]!.send({ type: 'scan', scanId: 7, origin: 'install', subjects: [{ path: 'index.js', content: 'EVIL' }] });
    await settle();
    const result = puppets[0]!.received.find((m) => m.type === 'scan-result');
    expect(result).toMatchObject({ scanId: 7, verdicts: [{ path: 'index.js', action: 'block' }] });
    expect(blocked(decisions)).toHaveLength(1);
  });

  it('answers incomplete, not clean, when the scanner throws', async () => {
    const failing: CodeScanner = { scan: async () => { throw new Error('worker crashed'); } };
    const { processes, puppets } = shieldHost({ scanner: failing });
    processes.spawnChild('node', []);
    puppets[0]!.send({ type: 'scan', scanId: 1, origin: 'install', subjects: [{ path: 'a.js', content: 'x' }] });
    await settle();
    expect(puppets[0]!.received.find((m) => m.type === 'scan-result')).toMatchObject({ verdicts: [{ complete: false }] });
  });

  it('does not tell a process to scan when the page has no scanner', () => {
    const { processes, puppets } = shieldHost();
    processes.spawnChild('node', []);
    expect(startOf(puppets[0]!).codeScan).toBeUndefined();
  });
});
