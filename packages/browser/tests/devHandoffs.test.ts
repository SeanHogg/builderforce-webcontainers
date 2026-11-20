/**
 * Dev-server handoffs on the page (M3/L6): each is its announcing process's, the
 * root counts only within that process's working directory, a port another
 * process listens on is not announceable, and an entry ends when its process
 * withdraws it (`unlisten`) or exits — the one before it is in force again.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, textResponse, type SecurityContext, type ShieldDecision } from '@seanhogg/builderforce-webcontainers-core';
import { DevHandoffs } from '../src/node/devHandoffs.js';
import { ProcessHost, type ProcessHostOptions, type WorkerLike } from '../src/node/processHost.js';

/** A Worker whose messages to the host the test sends itself. */
function scriptedWorkers() {
  const workers: WorkerLike[] = [];
  const createWorker = (): WorkerLike => {
    const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined };
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
}

function handoffHost(security?: ProcessHostOptions['security']) {
  const { workers, createWorker } = scriptedWorkers();
  const processes = new ProcessHost({
    ...(security ? { security } : {}),
    fs: new VirtualFileSystem(),
    cwd: '/home/project',
    createWorker,
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    previewUrl: 'https://app.test/__bfwc/p1/',
    packageCache: false,
    warmWorker: false,
  });
  /** Start a process and return a way to speak as its Worker. */
  const start = (cwd: string, identity?: SecurityContext) => {
    const before = workers.length;
    const proc = processes.run('sh', [], { cwd, ...(identity ? { identity } : {}) });
    const worker = workers[before]!;
    return { proc, send: (data: unknown) => worker.onmessage?.({ data }) };
  };
  return { processes, start };
}

const APP: SecurityContext = Object.freeze({ applicationId: 'app:proj:0123456789abcdef', serviceId: 'web' });

describe('DevHandoffs', () => {
  it('keeps the latest live entry in force and falls back when it ends', () => {
    const handoffs = new DevHandoffs();
    const changes: number[] = [];
    handoffs.onChange(() => changes.push(handoffs.list().length));
    handoffs.announce({ pid: 1, port: 5173, root: '/p/web' });
    handoffs.announce({ pid: 2, port: 4200, root: '/p/admin' });
    expect(handoffs.current()?.root).toBe('/p/admin');
    handoffs.end(2, 4200);
    expect(handoffs.current()?.root).toBe('/p/web');
    handoffs.end(1);
    expect(handoffs.current()).toBeUndefined();
    handoffs.end(1); // nothing left: no change
    expect(changes).toEqual([1, 2, 1, 0]);
  });
});

describe('ProcessHost handoff attribution', () => {
  it('records a handoff as the announcing process’s, with its identity, and ends it on withdrawal or exit', async () => {
    const { processes, start } = handoffHost();
    const web = start('/home/project', APP);
    web.send({ type: 'listening', port: 5173, url: 'ignored', root: '/home/project/web' });
    expect(processes.handoffs.current()).toMatchObject({ pid: web.proc.pid, port: 5173, root: '/home/project/web', context: APP });

    const admin = start('/home/project');
    admin.send({ type: 'listening', port: 4200, url: 'ignored', root: '/home/project/admin' });
    expect(processes.handoffs.current()?.root).toBe('/home/project/admin');
    admin.send({ type: 'unlisten', port: 4200 }); // interrupted: the shell lives on, the handoff ends
    expect(processes.handoffs.current()?.root).toBe('/home/project/web');

    web.send({ type: 'exit', code: 0 });
    await web.proc.wait();
    expect(processes.handoffs.current()).toBeUndefined();
    processes.dispose();
  });

  it('refuses another application’s handoff while one application’s is live, and reports it (N4)', async () => {
    const decisions: [SecurityContext, ShieldDecision][] = [];
    const { processes, start } = handoffHost({ onDecision: (context, decision) => decisions.push([context, decision]) });
    const OTHER: SecurityContext = Object.freeze({ applicationId: 'app:other:fedcba9876543210', serviceId: 'web' });
    const web = start('/home/project', APP);
    web.send({ type: 'listening', port: 5173, url: 'ignored', root: '/home/project/web' });
    const announced: number[] = [];
    processes.servers.onListening(({ port }) => announced.push(port));

    const rival = start('/home/project', OTHER);
    rival.send({ type: 'listening', port: 5174, url: 'ignored', root: '/home/project/other' });
    expect(processes.handoffs.list()).toHaveLength(1);
    expect(processes.handoffs.current()).toMatchObject({ pid: web.proc.pid, context: APP }); // the first keeps it
    expect(announced).toEqual([]);
    expect(decisions.map(([context, decision]) => [context.applicationId, context.serviceId, decision])).toEqual([[OTHER.applicationId, 'web', { allow: false, reason: 'ingress.handoff_conflict' }]]);

    // The same application re-announcing, and a workspace process, are not conflicts.
    web.send({ type: 'listening', port: 5175, url: 'ignored', root: '/home/project/web' });
    const shell = start('/home/project');
    shell.send({ type: 'listening', port: 4200, url: 'ignored', root: '/home/project/admin' });
    expect(processes.handoffs.list().map((entry) => entry.port)).toEqual([5173, 5175, 4200]);
    expect(decisions).toHaveLength(1);

    // Once the first application's handoff ends, the other's goes ahead.
    web.send({ type: 'exit', code: 0 });
    await web.proc.wait();
    rival.send({ type: 'listening', port: 5174, url: 'ignored', root: '/home/project/other' });
    expect(processes.handoffs.current()).toMatchObject({ pid: rival.proc.pid, context: OTHER });
    processes.dispose();
  });

  it('refuses a root outside the process’s working directory, and a port another process listens on', () => {
    const { processes, start } = handoffHost();
    const shell = start('/home/project/web');
    shell.send({ type: 'listening', port: 5173, url: 'ignored', root: '/home/project' }); // above its own cwd
    expect(processes.handoffs.current()).toMatchObject({ pid: shell.proc.pid, port: 5173 });
    expect(processes.handoffs.current()?.root).toBeUndefined();

    processes.ports.listen(8000, async () => textResponse(200, 'api'));
    const intruder = start('/home/project/web');
    intruder.send({ type: 'listening', port: 8000, url: 'ignored', root: '/home/project/web' });
    expect(processes.handoffs.current()?.pid).toBe(shell.proc.pid);
    processes.dispose();
  });
});
