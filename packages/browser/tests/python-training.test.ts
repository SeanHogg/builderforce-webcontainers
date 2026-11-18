/**
 * Training services (PRD 31 §W9 phase 7): a `type: 'training'` service runs a
 * Python entry point under startApplicationRuntime — ready once started, never
 * restarted, step/loss lines through `logs()`, a checkpoint request before the
 * stop, and its artifacts committed by the PAGE (keyed by the page-side
 * identity, never the env) to project storage outside the VFS.
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

describe('training service defaults', () => {
  it('is ready once started, never restarts, and has no port', () => {
    expect(readinessOf(training)).toEqual({ kind: 'started' });
    expect(restartPolicyOf(training)).toBe('never');
    expect(restartPolicyOf({ ...training, restartPolicy: 'on-failure' })).toBe('on-failure');
    expect(readinessOf({ ...training, type: 'application' })).toEqual({ kind: 'exit-zero' });
    expect(validateSpec({ projectId: 'p', services: [{ ...training, port: 8000 }] })).toContainEqual({ code: 'training-port', serviceId: 'train' });
    expect(validateSpec({ projectId: 'p', services: [training] })).toEqual([]);
  });

  it('the python provider accepts a training entry point, not a server', () => {
    const provider = createPythonProvider({} as NodeServiceHost);
    expect(provider.accepts(training)).toEqual({ ok: true });
    expect(provider.accepts({ ...training, command: 'uvicorn', args: ['main:app'] }).ok).toBe(false);
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
      const key = { projectId, applicationId: app.applicationId, serviceId: 'train' };
      // Without the channel there is no acknowledgement: the page's commit may land just after the exit.
      for (let tries = 0; tries < 100 && (await store.list(key)).length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await store.list(key)).toEqual(['adapter/adapter_config.json', 'adapter/adapter_model.safetensors']);
      expect(new TextDecoder().decode(await store.read(key, 'adapter/adapter_model.safetensors'))).toMatch(/^SAFETENSORS:\d/);
      expect(await store.list({ projectId: 'victim', applicationId: app.applicationId, serviceId: 'train' })).toEqual([]);
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
    expect(await store.list({ projectId, applicationId: app.applicationId, serviceId: 'train' })).toEqual(['c.txt']);
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
    expect(await store.list({ projectId, applicationId: app.applicationId, serviceId: 'train' })).toEqual([]);
    await app.dispose();
    processes.dispose();
  });
});

describe('training processes and the rest', () => {
  it('normal stdin still reaches a training program', { timeout: 120_000 }, async () => {
    const { processes, kinds } = trainingHost({ 'echo.py': 'from bfwc import training\nprint("flag:", training.checkpoint_requested())\nprint("read:", input())\n' });
    const identity = { applicationId: 'app-x', serviceId: 'train' };
    kinds.training!.register(identity);
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
    const handle = await provider.start(service, { env: {}, signal: new AbortController().signal, security: { applicationId: 'app-y', serviceId: 'job' } });
    expect(handle.checkpoint).toBeUndefined();
    expect(await readAll(handle.output)).toContain('this process is not a training service');
    expect(await handle.wait()).toBe(0);
    processes.dispose();
  });
});
