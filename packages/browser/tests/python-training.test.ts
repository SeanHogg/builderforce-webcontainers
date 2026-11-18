/**
 * Training services (PRD 31 §W9 phase 7): a `type: 'training'` service runs a
 * Python entry point under startApplicationRuntime — ready once started, never
 * restarted, step/loss lines through `logs()`, a checkpoint request before the
 * stop, and its artifacts committed by the PAGE (keyed by the host's project
 * id, the spec's projectId and the service — stable across runs, never the
 * env) to project storage outside the VFS. Only the process the provider
 * spawned is a training process; the sink and channel are unit-tested below.
 *
 * The training loops are minimal pure-Python scripts (the plumbing): the real
 * `import torch` comes from a host extension (`@webdit/torch/pyodide`), which
 * lives in another repository and is not a dependency of this one; the
 * extension seam itself is covered in python-integration.test.ts.
 *
 * The page → process channel (`notify`) is wired here at the Worker boundary
 * (start message pid → Worker), standing in for the process host's own.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readinessOf, restartPolicyOf, validateSpec, type ApplicationSpec, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { createPythonProcessKind, createPythonProvider, createTrainingArtifactStore, startApplicationRuntime, type ApplicationRuntime, type NodeServiceHost } from '../src/app.js';
import { createTrainingChannel } from '../src/runtimes/python/trainingChannel.js';
import { artifactKeyId, type TrainingArtifactKey, type TrainingArtifactStore } from '../src/runtimes/python/trainingArtifacts.js';
import type { TrainingSavedAck } from '../src/runtimes/python/trainingProtocol.js';
import { createTrainingSink, validArtifactPath } from '../src/runtimes/python/trainingSink.js';
import type { ProcessHost, WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import { appHost } from './databaseHelpers.js';
import { mixedWorkers, readAll } from './python-helpers.js';

const STORE_NAME = `bfwc-training-test-${Date.now()}`;
afterAll(
  () =>
    new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(STORE_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    }),
);

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

/** A runtime whose Python policy has training on, with the page → process channel connected. */
function trainingHost(files: Record<string, string>, options: { sharedFlags?: boolean; maxBytes?: number; connect?: boolean } = {}) {
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const store = createTrainingArtifactStore({ name: STORE_NAME });
  const kinds = createPythonProcessKind({ training: { projectId, store, sharedFlags: options.sharedFlags, maxBytes: options.maxBytes } });
  const byPid = new Map<number, WorkerLike>();
  const workers = mixedWorkers();
  const createWorker = (kind: WorkerKind) => {
    const worker = workers(kind);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: HostToWorker) => {
      if (message.type === 'start') byPid.set(message.pid, worker);
      post(message);
    };
    return worker;
  };
  const host = appHost(files, createWorker, kinds);
  if (options.connect !== false) kinds.training!.connect((pid, message) => (byPid.get(pid)?.postMessage(message as unknown as HostToWorker), byPid.has(pid)));
  const provider = createPythonProvider(runtimeOf(host.processes), { training: kinds.training });
  return { ...host, kinds, store, projectId, provider };
}

function follow(app: ApplicationRuntime, serviceId: string) {
  const lines: string[] = [];
  void (async () => {
    for await (const entry of app.logs(serviceId)) lines.push(entry.text);
  })();
  return {
    lines,
    text: () => lines.join('\n'),
    async until(pattern: RegExp, ms = 120_000) {
      const deadline = Date.now() + ms;
      while (!lines.some((line) => pattern.test(line))) {
        if (Date.now() > deadline) throw new Error(`No ${pattern} in:\n${lines.join('\n')}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

/**
 * Steps until asked to checkpoint, then writes the adapter outside the project and exits 0 (saved at exit).
 * `yieldEachStep`: the in-thread test Worker shares the page's thread — a real Worker does not — so with
 * a shared flag (which never suspends the program) the program must yield for the page's stop to run at all.
 */
const TRAIN = (yieldEachStep: boolean) => `
import asyncio, json, os
from pyodide.ffi import run_sync
from bfwc import training

w, step = 0.0, 0
while step < 200000:
    loss = (w - 3.0) ** 2
    w -= 0.1 * 2 * (w - 3.0)
    training.log(step, loss, lr=0.1)
    step += 1
    if ${yieldEachStep ? 'True' : 'False'}:
        run_sync(asyncio.sleep(0.001))
    if training.checkpoint_requested():
        print("checkpoint requested", flush=True)
        break
out = training.artifact_dir("adapter")
open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"SAFETENSORS:" + str(round(w, 3)).encode())
open(os.path.join(out, "adapter_config.json"), "w").write(json.dumps({"steps": step}))
print("wrote adapter", flush=True)
`;

const training: ServiceSpec = { id: 'train', type: 'training', runtime: 'python', command: 'python', args: ['train.py'] };

/** An in-memory artifact store; `delayMs` holds each replace (commit order under load). */
function memoryStore(delayMs = 0): TrainingArtifactStore & { sets: Map<string, Map<string, Uint8Array>>; order: string[] } {
  const sets = new Map<string, Map<string, Uint8Array>>();
  const order: string[] = [];
  const id = artifactKeyId;
  return {
    sets,
    order,
    async replace(key, files) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      sets.set(id(key), new Map(files));
      order.push([...files.keys()].join(','));
    },
    read: async (key, path) => sets.get(id(key))?.get(path),
    list: async (key) => [...(sets.get(id(key))?.keys() ?? [])].sort(),
    remove: async (key) => void sets.delete(id(key)),
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('training service defaults', () => {
  it('is ready once started, never restarts, and has no port', () => {
    expect(readinessOf(training)).toEqual({ kind: 'started' });
    expect(restartPolicyOf(training)).toBe('never');
    expect(restartPolicyOf({ ...training, restartPolicy: 'on-failure' })).toBe('on-failure');
    expect(readinessOf({ ...training, type: 'application' })).toEqual({ kind: 'exit-zero' });
    expect(validateSpec({ projectId: 'p', services: [{ ...training, port: 8000 }] })).toContainEqual({ code: 'training-port', serviceId: 'train' });
    expect(validateSpec({ projectId: 'p', services: [training] })).toEqual([]);
  });

  it('the python provider accepts a training entry point, not a server — and declines training without a training channel', () => {
    const provider = createPythonProvider({} as NodeServiceHost, { training: createPythonProcessKind({ training: { projectId: 'h', store: memoryStore() } }).training });
    expect(provider.accepts(training)).toEqual({ ok: true });
    expect(provider.accepts({ ...training, command: 'uvicorn', args: ['main:app'] }).ok).toBe(false);
    const without = createPythonProvider({} as NodeServiceHost).accepts(training);
    expect(without.ok).toBe(false);
    expect(!without.ok && without.reason).toMatch(/no training channel/);
  });
});

describe('a training service under startApplicationRuntime', () => {
  for (const sharedFlags of [true, false]) {
    it(`streams step/loss lines, checkpoints before it stops, and the page keeps its adapter (${sharedFlags ? 'shared flag' : 'checkpoint message'})`, { timeout: 180_000 }, async () => {
      // The shared-flag run has no page → process channel: the flag alone must carry the checkpoint.
      const { fs, processes, store, projectId, provider } = trainingHost({ 'train.py': TRAIN(sharedFlags) }, { sharedFlags, connect: !sharedFlags });
      // The env claims another project and service: it must change nothing about where artifacts go.
      const spec: ApplicationSpec = { projectId: 'spec-project', services: [{ ...training, env: { BUILDERFORCE_PROJECT_ID: 'victim', BUILDERFORCE_SERVICE: 'victim' } }] };
      const app = startApplicationRuntime(spec, { runtime: processes, providers: [provider], stopTimeoutMs: 30_000 });
      const logs = follow(app, 'train');
      await app.start();
      expect(app.getService('train')?.state).toBe('running');
      await logs.until(/^step=5 loss=/);
      expect(logs.lines.some((line) => /^step=0 loss=9 lr=0\.1/.test(line))).toBe(true);

      await app.stop();
      expect(logs.text()).toContain('checkpoint requested');
      expect(logs.text()).toContain('wrote adapter');
      expect(logs.text()).not.toContain('were not saved');
      const snapshot = app.getService('train')!;
      expect(snapshot.exitCode).toBe(0);
      expect(snapshot.restarts).toBe(0);

      // Outside the VFS, under the host's project id and the page-side identity.
      expect(fs.exists('/bfwc-artifacts')).toBe(false);
      const key = { projectId, specProjectId: 'spec-project', serviceId: 'train' };
      // Without the channel there is no acknowledgement: the page's commit may land just after the exit.
      for (let tries = 0; tries < 100 && (await store.list(key)).length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await store.list(key)).toEqual(['adapter/adapter_config.json', 'adapter/adapter_model.safetensors']);
      expect(new TextDecoder().decode(await store.read(key, 'adapter/adapter_model.safetensors'))).toMatch(/^SAFETENSORS:\d/);
      expect(await store.list({ projectId: 'victim', specProjectId: 'spec-project', serviceId: 'train' })).toEqual([]);
      expect(await store.list({ ...key, specProjectId: 'victim' })).toEqual([]);
      expect(await store.list({ ...key, serviceId: 'victim' })).toEqual([]);
      await store.remove(key);
      expect(await store.list(key)).toEqual([]);
      await app.dispose();
      processes.dispose();
    });
  }

  it('a program that ignores the checkpoint is stopped with SIGTERM after the deadline', { timeout: 120_000 }, async () => {
    const IGNORE = 'import asyncio\nfrom pyodide.ffi import run_sync\nprint("ignoring", flush=True)\nwhile True:\n    run_sync(asyncio.sleep(0.02))\n';
    const { processes, provider } = trainingHost({ 'train.py': IGNORE });
    const app = startApplicationRuntime({ projectId: 'p', services: [training] }, { runtime: processes, providers: [provider], stopTimeoutMs: 500 });
    const logs = follow(app, 'train');
    await app.start();
    await logs.until(/ignoring/);
    const started = Date.now();
    await app.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(app.getService('train')?.exitCode).toBe(143);
    await app.dispose();
    processes.dispose();
  });

  it('skips symlinks, a save replaces the set, and the exit saves without an explicit save()', { timeout: 120_000 }, async () => {
    const PROGRAM = `
import os
from bfwc import training
d = training.artifact_dir()
open(os.path.join(d, "a.txt"), "w").write("a")
open(os.path.join(d, "b.txt"), "w").write("b")
open("/project/secret.txt", "w").write("not an artifact")
os.symlink("/project/secret.txt", os.path.join(d, "link.txt"))
training.save()
print("first save ok", flush=True)
os.remove(os.path.join(d, "a.txt"))
os.remove(os.path.join(d, "b.txt"))
open(os.path.join(d, "c.txt"), "w").write("c")
try:
    training.artifact_dir("..", "etc")
except ValueError:
    print("escape refused", flush=True)
`;
    const { processes, store, projectId, provider } = trainingHost({ 'train.py': PROGRAM });
    const app = startApplicationRuntime({ projectId: 'p', services: [training] }, { runtime: processes, providers: [provider] });
    const logs = follow(app, 'train');
    await app.start();
    await logs.until(/Exited with code 0|Failed/);
    expect(logs.text()).toContain('first save ok');
    expect(logs.text()).toContain('escape refused');
    expect(await store.list({ projectId, specProjectId: 'p', serviceId: 'train' })).toEqual(['c.txt']);
    await app.dispose();
    processes.dispose();
  });

  it('a save the page refuses raises in Python', { timeout: 120_000 }, async () => {
    const PROGRAM = 'from bfwc import training\nimport os\nopen(os.path.join(training.artifact_dir(), "big.bin"), "wb").write(b"x" * 100)\ntry:\n    training.save()\nexcept RuntimeError as error:\n    print("refused:", error, flush=True)\n';
    const { processes, store, projectId, provider } = trainingHost({ 'train.py': PROGRAM }, { maxBytes: 10 });
    const app = startApplicationRuntime({ projectId: 'p', services: [training] }, { runtime: processes, providers: [provider] });
    const logs = follow(app, 'train');
    await app.start();
    await logs.until(/Exited with code|Failed/);
    expect(logs.text()).toMatch(/refused: bfwc\.training\.save: The save is over 10 bytes/);
    expect(await store.list({ projectId, specProjectId: 'p', serviceId: 'train' })).toEqual([]);
    await app.dispose();
    processes.dispose();
  });
});

describe('training processes and the rest', () => {
  it('normal stdin still reaches a training program', { timeout: 120_000 }, async () => {
    const { processes, kinds } = trainingHost({ 'echo.py': 'from bfwc import training\nprint("flag:", training.checkpoint_requested())\nprint("read:", input())\n' });
    const identity = { applicationId: 'app-x', serviceId: 'train' };
    kinds.training!.expect(identity, { specProjectId: 'p', serviceId: 'train' });
    const proc = processes.run('python', ['echo.py'], { identity });
    const writer = proc.stdin.getWriter();
    await writer.write('hello\n');
    await writer.close();
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(0);
    expect(output).toContain('flag: False');
    expect(output).toContain('read: hello');
    processes.dispose();
  });

  it('an application service has no checkpoint handle, and its process no training control', { timeout: 120_000 }, async () => {
    const { processes, provider } = trainingHost({ 'app.py': 'from bfwc import training\ntry:\n    training.checkpoint_requested()\nexcept RuntimeError as error:\n    print(error)\n' });
    const service: ServiceSpec = { id: 'job', type: 'application', runtime: 'python', command: 'python', args: ['app.py'] };
    const handle = await provider.start(service, { env: {}, signal: new AbortController().signal, security: { applicationId: 'app-y', serviceId: 'job' }, projectId: 'p' });
    expect(handle.checkpoint).toBeUndefined();
    expect(await readAll(handle.output)).toContain('this process is not a training service');
    expect(await handle.wait()).toBe(0);
    processes.dispose();
  });
});

describe('a stable artifact key across runs', () => {
  it('the next run of the same application reads the last save; a run that crashes before writing anything keeps it', { timeout: 180_000 }, async () => {
    const WRITE = 'import os\nfrom bfwc import training\nopen(os.path.join(training.artifact_dir(), "a.txt"), "w").write("a")\n';
    const CRASH = 'raise RuntimeError("boom before any artifact")\n';
    const { fs, processes, store, projectId, provider } = trainingHost({ 'train.py': WRITE });
    const key = { projectId, specProjectId: 'stable', serviceId: 'train' };
    const first = startApplicationRuntime({ projectId: 'stable', services: [training] }, { runtime: processes, providers: [provider] });
    const firstLogs = follow(first, 'train');
    await first.start();
    await firstLogs.until(/Exited with code|Failed/);
    expect(await store.list(key)).toEqual(['a.txt']);
    await first.dispose();

    fs.writeFile('/train.py', CRASH);
    const second = startApplicationRuntime({ projectId: 'stable', services: [training] }, { runtime: processes, providers: [provider] });
    expect(second.applicationId).toBe(first.applicationId); // an application's identity is stable across runs (W10 control 1: its origin key)
    const secondLogs = follow(second, 'train');
    await second.start();
    await secondLogs.until(/Exited with code|Failed/);
    expect(secondLogs.text()).toContain('boom before any artifact');
    expect(await store.list(key)).toEqual(['a.txt']);
    expect(new TextDecoder().decode(await store.read(key, 'a.txt'))).toBe('a');
    await second.dispose();
    processes.dispose();
  });
});

describe('the training sink', () => {
  const key: TrainingArtifactKey = { projectId: 'h', specProjectId: 's', serviceId: 'train' };
  const artifact = (saveId: number, path: string, text = path) => ({ type: 'training-artifact' as const, saveId, path, bytes: bytes(text) });
  const saved = (saveId: number, files: number) => ({ type: 'training-saved' as const, saveId, files });
  function sink(options: { maxBytes?: number; maxFiles?: number; delayMs?: number } = {}) {
    const store = memoryStore(options.delayMs);
    const acks: TrainingSavedAck[] = [];
    const s = createTrainingSink({ store, maxBytes: options.maxBytes, maxFiles: options.maxFiles });
    const from = (pid: number) => ({ pid, key });
    return { store, acks, reply: (ack: TrainingSavedAck) => void acks.push(ack), sink: s, from };
  }

  it('refuses paths outside the artifact directory, and the whole save with them', async () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a\u0000b', 'x'.repeat(1025)]) expect(validArtifactPath(bad), bad).toBe(false);
    expect(validArtifactPath('adapter/adapter_model.safetensors')).toBe(true);
    const { sink: s, store, acks, reply, from } = sink();
    await store.replace(key, new Map([['keep.txt', bytes('keep')]]));
    s.receive(artifact(1, 'ok.txt'), from(1));
    s.receive(artifact(1, '../escape'), from(1));
    s.receive(saved(1, 2), from(1), reply);
    await until(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ saveId: 1, ok: false, error: expect.stringMatching(/Refused artifact path/) });
    expect(await store.list(key)).toEqual(['keep.txt']);
  });

  it('refuses a save over maxFiles or maxBytes whole', async () => {
    const { sink: s, store, acks, reply, from } = sink({ maxFiles: 2, maxBytes: 100 });
    for (const path of ['a', 'b', 'c']) s.receive(artifact(1, path), from(1));
    s.receive(saved(1, 3), from(1), reply);
    s.receive(artifact(2, 'big', 'x'.repeat(101)), from(1));
    s.receive(saved(2, 1), from(1), reply);
    await until(() => acks.length === 2);
    expect(acks.map((ack) => ack.error)).toEqual(['The save is over 2 files.', 'The save is over 100 bytes.']);
    expect(store.sets.size).toBe(0);
  });

  it('interleaved, stale or incomplete save ids never commit a partial (or empty) set', async () => {
    const { sink: s, store, acks, reply, from } = sink();
    await store.replace(key, new Map([['good.txt', bytes('good')]]));
    s.receive(artifact(1, 'one.txt'), from(1));
    s.receive(artifact(2, 'two.txt'), from(1)); // save 2 abandons save 1
    s.receive(saved(1, 1), from(1), reply); // save 1 is no longer the one being received
    s.receive(saved(2, 2), from(1), reply); // save 2 sent one file, claims two
    s.receive(saved(1, 0), from(1), reply); // a stale id cannot empty the set
    await until(() => acks.length === 3);
    expect(acks.map((ack) => [ack.saveId, ack.ok])).toEqual([
      [1, false],
      [1, false],
      [2, false],
    ]);
    expect(acks[2]!.error).toMatch(/incomplete \(1 of 2 files\)/);
    expect(await store.list(key)).toEqual(['good.txt']);
    s.receive(artifact(3, 'three.txt'), from(1));
    s.receive(saved(3, 1), from(1), reply);
    await until(() => acks.length === 4);
    expect(acks[3]).toMatchObject({ saveId: 3, ok: true });
    expect(await store.list(key)).toEqual(['three.txt']);
  });

  it('a process killed mid-stream leaves nothing behind: its buffer is dropped and a late save of it is refused', async () => {
    const { sink: s, store, acks, reply, from } = sink();
    await store.replace(key, new Map([['good.txt', bytes('good')]]));
    s.receive(artifact(1, 'half.txt'), from(7));
    s.exited(7);
    s.receive(saved(1, 1), from(7), reply);
    await until(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ saveId: 1, ok: false });
    expect(await store.list(key)).toEqual(['good.txt']);
  });

  it("commits one service's saves in order, with at most one queued: a superseded save is acked as superseded", async () => {
    const { sink: s, store, acks, reply, from } = sink({ delayMs: 30 });
    for (const id of [1, 2, 3]) {
      s.receive(artifact(id, `f${id}`), from(1));
      s.receive(saved(id, 1), from(1), reply);
    }
    await until(() => acks.length === 3);
    // 1 commits; 2 queues behind it and is replaced by 3.
    expect(acks.map((ack) => [ack.saveId, ack.ok, ack.superseded ?? false])).toEqual([
      [2, false, true],
      [1, true, false],
      [3, true, false],
    ]);
    expect(store.order).toEqual(['f1', 'f3']);
    expect(await store.list(key)).toEqual(['f3']);
  });
});

describe('the training channel', () => {
  const A = { applicationId: 'app:a:1', serviceId: 'train' };
  const artifactKey = { specProjectId: 'spec-a', serviceId: 'train' };
  function channel(sharedFlags = true) {
    const store = memoryStore();
    const notes: Array<[number, unknown]> = [];
    const c = createTrainingChannel({ projectId: 'host', store, sharedFlags });
    c.connect((pid, message) => (notes.push([pid, message]), true));
    return { c, store, notes, key: { projectId: 'host', ...artifactKey } };
  }

  it('grants the training control to the one spawn the provider expected — not its children, not a start without a processId', () => {
    const { c } = channel();
    c.expect(A, artifactKey);
    expect(c.startOptions(A)).toBeUndefined(); // no processId: refused, and the expectation stays
    const root = c.startOptions({ ...A, processId: 10 });
    expect(root).toMatchObject({ acks: true });
    expect(root!.flag).toBeInstanceOf(SharedArrayBuffer);
    expect(c.startOptions({ ...A, processId: 11 })).toBeUndefined(); // a child: same identity, consumed
    const release = c.expect(A, artifactKey);
    release();
    expect(c.startOptions({ ...A, processId: 12 })).toBeUndefined(); // released before any spawn
  });

  it("a child's save, another identity's, or a forged sender cannot wipe or replace the service's set", async () => {
    const { c, store, key } = channel();
    await store.replace(key, new Map([['good.txt', bytes('good')]]));
    c.expect(A, artifactKey);
    c.startOptions({ ...A, processId: 10 });
    const empty = { type: 'training-saved', saveId: 1, files: 0 };
    expect(c.receive(empty, { ...A, processId: 11 })).toBe(true); // the root's child
    expect(c.receive(empty, { applicationId: 'app:b:1', serviceId: 'train', processId: 10 })).toBe(true); // the pid, claimed by another identity
    expect(c.receive(empty, undefined)).toBe(true); // not a usable sender
    expect(c.refused).toBe(3);
    await flush();
    expect(await store.list(key)).toEqual(['good.txt']);
    expect(c.receive({ type: 'python-installed' }, { ...A, processId: 10 })).toBe(false); // not a training message
  });

  it('checkpoints every live training process of the service; an exited one is dropped (flag, grant, buffer)', () => {
    const { c, notes } = channel();
    c.expect(A, artifactKey);
    const first = new Int32Array(c.startOptions({ ...A, processId: 10 })!.flag!);
    c.expect(A, artifactKey);
    const second = new Int32Array(c.startOptions({ ...A, processId: 20 })!.flag!);
    c.expect({ ...A, serviceId: 'other' }, { ...artifactKey, serviceId: 'other' });
    const other = new Int32Array(c.startOptions({ ...A, serviceId: 'other', processId: 30 })!.flag!);
    expect(c.checkpoint(20)).toBe(2);
    expect([Atomics.load(first, 0), Atomics.load(second, 0), Atomics.load(other, 0)]).toEqual([1, 1, 0]);
    expect(notes.map(([pid]) => pid).sort()).toEqual([10, 20]);
    notes.length = 0;
    // Another application from the same spec shares the artifact key, never the stop.
    c.expect({ ...A, applicationId: 'app:a:2' }, artifactKey);
    const sibling = new Int32Array(c.startOptions({ ...A, applicationId: 'app:a:2', processId: 40 })!.flag!);
    expect(c.checkpoint(20)).toBe(2);
    expect(Atomics.load(sibling, 0)).toBe(0);
    expect(c.granted(40)).toBe(true);
    c.exited(10);
    expect(c.granted(10)).toBe(false);
    expect(c.checkpoint(20)).toBe(1);
    expect(c.checkpoint(10)).toBe(0);
    expect(c.receive({ type: 'training-saved', saveId: 1, files: 0 }, { ...A, processId: 10 })).toBe(true);
    expect(c.refused).toBe(1);
  });

  it('without shared flags a training process gets none, and the checkpoint goes by message', () => {
    const { c, notes } = channel(false);
    c.expect(A, artifactKey);
    expect(c.startOptions({ ...A, processId: 10 })).toEqual({ acks: true });
    expect(c.checkpoint(10)).toBe(1);
    expect(notes).toEqual([[10, { type: 'checkpoint' }]]);
  });

  it('forgetApplication drops its expected spawns and its processes; other applications keep theirs', () => {
    const { c } = channel();
    const B = { applicationId: 'app:b:1', serviceId: 'train' };
    c.expect(A, artifactKey);
    c.startOptions({ ...A, processId: 10 });
    c.expect(A, artifactKey);
    c.expect(B, { ...artifactKey, specProjectId: 'spec-b' });
    c.startOptions({ ...B, processId: 20 });
    c.forgetApplication(A.applicationId);
    expect(c.checkpoint(10)).toBe(0);
    expect(c.startOptions({ ...A, processId: 11 })).toBeUndefined();
    expect(c.checkpoint(20)).toBe(1);
  });
});

describe('forgetApplication through the policy', () => {
  it("drops the application's pip record and training state; the workspace's record stays", () => {
    const kinds = createPythonProcessKind({ training: { projectId: 'h', store: memoryStore(), sharedFlags: false } });
    const A = { applicationId: 'app:a:1', serviceId: 'train' };
    kinds.pipRecordFor(A).add({ specs: ['x==1'], indexUrls: [] });
    kinds.pipRecord.add({ specs: ['w==1'], indexUrls: [] });
    kinds.training!.expect(A, { specProjectId: 's', serviceId: 'train' });
    kinds.forgetApplication(A.applicationId);
    expect(kinds.pipRecordFor(A).read()).toEqual([]);
    expect(kinds.pipRecord.read().map((install) => install.specs)).toEqual([['w==1']]);
    expect(kinds.startOptions('python', { ...A, processId: 5 }).python?.training).toBeUndefined();
  });

  it('an application disposed by startApplicationRuntime is forgotten by its runtime', async () => {
    const forgotten: string[] = [];
    const runtime = { killApplication: () => undefined, forgetApplication: (id: string) => void forgotten.push(id), portPolicy: { register: () => () => undefined } };
    const app = startApplicationRuntime({ projectId: 'p', services: [] }, { runtime, providers: [] });
    await app.stop();
    expect(forgotten).toEqual([]);
    await app.dispose();
    expect(forgotten).toEqual([app.applicationId]);
  });
});
