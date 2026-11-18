/**
 * The Python runtime's host side, without an interpreter: the process-kind
 * policy (routing, start options, which `python-installed` reports are kept),
 * the pip record's per-install groups, the relay's Worker kinds, the Worker
 * supply's Python spawns, and the confinement of host extensions.
 */
import { describe, expect, it } from 'vitest';
import { VfsSnapshots, VirtualFileSystem, WORKSPACE_CONTEXT } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerLike } from '../src/node/processHost.js';
import type { WorkerKind } from '../src/node/protocol.js';
import { WorkerSupply } from '../src/node/workerSupply.js';
import { RELAY_SPAWN } from '../src/protocol.js';
import { RELAY_PROCESS_WORKER, RELAY_PYTHON_WORKER, relayWorkerScript, spawnOverRelay } from '../src/relayWorker.js';
import { PIP_RECORD_LIMITS, createPipRecord, createPythonProcessKind, installPythonExtensions, validPipInstall, type PyodideLike } from '../src/runtimes/python/index.js';

const context = (files: Record<string, string> = {}) => {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return { fs, cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } };
};

describe('the Python process-kind policy', () => {
  it('routes Python commands, and scripts whose shebang names Python, to Python Workers', () => {
    const kinds = createPythonProcessKind();
    const files = context({ 'manage.py': '#!/usr/bin/env python3\nprint(1)\n', 'tool.py': '#!/usr/local/bin/python -u\n', 'run.sh': '#!/bin/sh\necho\n', 'app.js': 'console.log(1)' });
    expect(kinds.route('uvicorn', ['main:app'], files)).toEqual({ kind: 'python', command: 'uvicorn', args: ['main:app'] });
    expect(kinds.route('./manage.py', ['migrate'], files)).toEqual({ kind: 'python', command: 'python3', args: ['/manage.py', 'migrate'] });
    expect(kinds.route('/tool.py', [], files)).toEqual({ kind: 'python', command: 'python', args: ['/tool.py'] });
    expect(kinds.route('./run.sh', [], files)).toMatchObject({ kind: 'node' });
    expect(kinds.route('node', ['app.js'], files)).toMatchObject({ kind: 'node' });
    expect(new RegExp(kinds.foreignCommands!).test('python3.12')).toBe(true);
    expect(new RegExp(kinds.foreignCommands!).test('node')).toBe(false);
  });

  it('keeps python-installed reports from Python processes only, and only well-formed ones', () => {
    const kinds = createPythonProcessKind({ pyodideIndexURL: 'https://cdn.example/pyodide/' });
    const report = { type: 'python-installed', specs: ['fixturepkg==1.0'], indexUrls: ['https://pypi.example/simple'] };
    expect(kinds.receive('node', report, WORKSPACE_CONTEXT)).toBe(true); // taken, and refused: a Node process cannot speak for pip
    expect(kinds.receive('python', { ...report, specs: [42] }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.receive('python', { ...report, indexUrls: ['file:///etc/passwd'] }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.receive('python', { ...report, indexUrls: ['https://user:secret@pypi.example/simple'] }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.receive('python', { ...report, specs: Array.from({ length: PIP_RECORD_LIMITS.specsPerInstall + 1 }, (_, i) => `p${i}`) }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.receive('python', { ...report, specs: ['x'.repeat(PIP_RECORD_LIMITS.specLength + 1)] }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.receive('python', { ...report, specs: ['evil\nline'] }, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.rejectedReports).toBe(7);
    expect(kinds.pipRecord.read()).toEqual([]);
    expect(kinds.receive('python', report, WORKSPACE_CONTEXT)).toBe(true);
    expect(kinds.pipRecord.read()).toEqual([{ specs: ['fixturepkg==1.0'], indexUrls: ['https://pypi.example/simple'] }]);
    expect(kinds.receive('python', { type: 'stdout', data: 'x' }, WORKSPACE_CONTEXT)).toBe(false);
    expect(kinds.startOptions('python', WORKSPACE_CONTEXT)).toEqual({ python: { indexURL: 'https://cdn.example/pyodide/', extensions: undefined, installs: kinds.pipRecord.read() } });
    expect(kinds.startOptions('node', WORKSPACE_CONTEXT)).toEqual({});
  });

  it('records each install as its own group, identical ones once, up to the session cap', () => {
    const record = createPipRecord();
    expect(record.add({ specs: ['a'], indexUrls: ['https://one/simple'] })).toBe(true);
    expect(record.add({ specs: ['b'], indexUrls: [] })).toBe(true);
    expect(record.add({ specs: ['a'], indexUrls: ['https://one/simple'] })).toBe(true);
    expect(record.read()).toEqual([{ specs: ['a'], indexUrls: ['https://one/simple'] }, { specs: ['b'], indexUrls: [] }]);
    for (let i = 0; i < PIP_RECORD_LIMITS.installs; i++) record.add({ specs: [`p${i}`], indexUrls: [] });
    expect(record.read()).toHaveLength(PIP_RECORD_LIMITS.installs);
    expect(validPipInstall({ specs: [], indexUrls: [] })).toBeUndefined();
    expect(validPipInstall(null)).toBeUndefined();
  });
});

describe('Worker kinds', () => {
  it('the relay is asked for the Worker kind, and starts the matching script', () => {
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const worker = spawnOverRelay((message, transfer) => posted.push({ message, transfer }), 'python');
    expect(posted[0]!.message).toEqual({ type: RELAY_SPAWN, worker: 'python' });
    expect(posted[0]!.transfer).toHaveLength(1);
    worker.terminate();
    expect(relayWorkerScript('python')).toEqual({ file: RELAY_PYTHON_WORKER, name: 'bfwc-python' });
    expect(relayWorkerScript('node')).toEqual({ file: RELAY_PROCESS_WORKER, name: 'bfwc-process' });
    expect(relayWorkerScript('anything else')).toEqual({ file: RELAY_PROCESS_WORKER, name: 'bfwc-process' });
  });

  it('a Python spawn is cold and leaves the primed Node spare for the next Node spawn', async () => {
    const created: WorkerKind[] = [];
    const fakeWorker = (kind: WorkerKind): WorkerLike => {
      created.push(kind);
      const worker: WorkerLike = {
        onmessage: null,
        postMessage: (message) => (message as { type?: string }).type === 'prime' && queueMicrotask(() => worker.onmessage?.({ data: { type: 'primed' } })),
        terminate: () => undefined,
      };
      return worker;
    };
    const fs = new VirtualFileSystem();
    const supply = new WorkerSupply(fakeWorker, new VfsSnapshots(fs), true);
    supply.take('node'); // schedules a spare
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(supply.primes).toBe(1);
    const python = supply.take('python');
    expect(python.snapshot.pack).toBeDefined(); // cold: the whole snapshot
    expect(created).toEqual(['node', 'node', 'python']);
    const node = supply.take('node');
    expect(node.snapshot.pack).toBeUndefined(); // the spare, primed before the Python spawn
    expect(supply.warmStarts).toBe(1);
    supply.dispose();
  });
});

/** Just enough of Pyodide to watch what an extension writes and registers. */
function fakePyodide() {
  const written: string[] = [];
  const modules: string[] = [];
  const pyodide = {
    FS: { mkdirTree: () => undefined, writeFile: (path: string) => written.push(path) },
    registerJsModule: (name: string) => modules.push(name),
    runPython: () => undefined,
  } as unknown as PyodideLike;
  return { pyodide, written, modules };
}

const extension = (value: object) => async () => ({ make: () => value });

describe('host extensions are confined', () => {
  it('installs files under their root, and maps provides to imports', async () => {
    const { pyodide, written, modules } = fakePyodide();
    const provided = await installPythonExtensions(pyodide, [{ moduleUrl: 'x', exportName: 'make' }], extension({ jsModules: { _engine: {} }, files: { 'sklearn/__init__.py': '' }, root: '/opt/ext', provides: ['scikit-learn'], imports: ['sklearn'] }));
    expect(written).toEqual(['/opt/ext/sklearn/__init__.py']);
    expect(modules).toEqual(['_engine']);
    expect([...provided.packages]).toEqual(['scikit-learn']);
    expect([...provided.imports]).toEqual(['sklearn']);
  });

  it('refuses files escaping the root, and a root in the project — before writing anything', async () => {
    for (const bad of [
      { files: { '../escape.py': '' }, root: '/opt/ext' },
      { files: { '/etc/passwd': '' }, root: '/opt/ext' },
      { files: { 'a.py': '' }, root: '/project/vendor' },
      { files: { 'a.py': '' }, root: '/' },
    ]) {
      const { pyodide, written, modules } = fakePyodide();
      await expect(installPythonExtensions(pyodide, [{ moduleUrl: 'x', exportName: 'make' }], extension({ ...bad, jsModules: { _m: {} } }))).rejects.toThrow(/outside its root|overlaps the project/);
      expect(written).toEqual([]);
      expect(modules).toEqual([]);
    }
  });
});
