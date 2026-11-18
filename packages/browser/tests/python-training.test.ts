/**
 * Training services (PRD 31 §W9 phase 7): a `type: 'training'` service runs a
 * Python entry point under startApplicationRuntime — ready once started, never
 * restarted, step/loss lines through `logs()`, a checkpoint request before the
 * stop, and its adapter kept in project storage outside the VFS.
 *
 * The training loop here is a minimal pure-Python script (the plumbing): the
 * real `import torch` comes from a host extension (`@webdit/torch/pyodide`),
 * which lives in another repository and is not a dependency of this one; the
 * extension seam itself is covered in python-integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readinessOf, restartPolicyOf, validateSpec, type ApplicationSpec, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { createPythonProcessKind, createPythonProvider, createTrainingArtifactStore, startApplicationRuntime, TRAINING_ARTIFACT_DIR, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost } from './databaseHelpers.js';
import { mixedWorkers } from './python-helpers.js';

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

/** Steps until asked to checkpoint (or 10 000 steps), then writes the adapter outside the project and exits 0. */
const TRAIN = `
import json, os
from bfwc import training

w, loss, step = 0.0, 1.0, 0
while step < 10000:
    loss = (w - 3.0) ** 2
    w -= 0.1 * 2 * (w - 3.0)
    training.log(step, loss, lr=0.1)
    step += 1
    if training.checkpoint_requested():
        print("checkpoint requested", flush=True)
        break
out = training.artifact_dir("adapter")
open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"SAFETENSORS:" + str(round(w, 3)).encode())
open(os.path.join(out, "adapter_config.json"), "w").write(json.dumps({"steps": step}))
training.save()
print("saved", flush=True)
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
  it('streams step/loss lines, checkpoints before it stops, and keeps its adapter outside the VFS', { timeout: 180_000 }, async () => {
    const { fs, processes } = appHost({ 'train.py': TRAIN }, mixedWorkers(), createPythonProcessKind());
    const projectId = `train-${Date.now()}`;
    const spec: ApplicationSpec = { projectId, services: [training] };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPythonProvider(runtimeOf(processes))], stopTimeoutMs: 30_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('train')) logs.push(entry.text);
    })();

    await app.start();
    expect(app.getService('train')?.state).toBe('running');
    const deadline = Date.now() + 120_000;
    while (!logs.some((line) => /step=5 loss=/.test(line)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logs.some((line) => /^step=0 loss=9 lr=0\.1/.test(line))).toBe(true);

    await app.stop();
    const text = logs.join('\n');
    // The checkpoint request reached the program before any signal: it saved and exited on its own.
    expect(text).toContain('checkpoint requested');
    expect(text).toContain('saved');
    const snapshot = app.getService('train')!;
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.restarts).toBe(0);

    // Outside the VFS: nothing under the project, everything in project storage.
    expect(fs.exists(TRAINING_ARTIFACT_DIR)).toBe(false);
    expect(fs.exists('/adapter')).toBe(false);
    const store = createTrainingArtifactStore();
    expect(await store.list(projectId, 'train')).toEqual(['adapter/adapter_config.json', 'adapter/adapter_model.safetensors']);
    const adapter = await store.read(projectId, 'train', 'adapter/adapter_model.safetensors');
    expect(new TextDecoder().decode(adapter)).toMatch(/^SAFETENSORS:\d/);
    await app.dispose();
    processes.dispose();
  });
});
