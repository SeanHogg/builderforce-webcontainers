/**
 * The PHP runtime's host side: the relay's PHP Worker kind, the Worker
 * supply's PHP spawns (always cold, never a primed Node spare), the chained
 * process-kind policy (PHP, then Python, then Node), and — on a real php-wasm —
 * a Node process spawning `php -r` through child_process and a shell running
 * `php …`, both routed to a PHP Worker by the process host.
 */
import { describe, expect, it } from 'vitest';
import { VfsSnapshots, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { WorkerKind } from '../src/node/protocol.js';
import { WorkerSupply } from '../src/node/workerSupply.js';
import { RELAY_SPAWN } from '../src/protocol.js';
import { RELAY_PHP_WORKER, RELAY_PROCESS_WORKER, RELAY_PYTHON_WORKER, relayWorkerScript, spawnOverRelay } from '../src/relayWorker.js';
import { createPhpProcessKind } from '../src/runtimes/php/index.js';
import { createPythonProcessKind } from '../src/runtimes/python/index.js';
import { fakeWorker } from './helpers.js';
import { fakePhpWorker, readAll } from './php-helpers.js';

describe('PHP Worker kind', () => {
  it('the relay is asked for a php Worker, and starts php-worker.js', () => {
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const worker = spawnOverRelay((message, transfer) => posted.push({ message, transfer }), 'php');
    expect(posted[0]!.message).toEqual({ type: RELAY_SPAWN, worker: 'php' });
    expect(posted[0]!.transfer).toHaveLength(1);
    worker.terminate();
    expect(relayWorkerScript('php')).toEqual({ file: RELAY_PHP_WORKER, name: 'bfwc-php' });
    expect(RELAY_PHP_WORKER).toBe('php-worker.js');
    expect(relayWorkerScript('python')).toEqual({ file: RELAY_PYTHON_WORKER, name: 'bfwc-python' });
    expect(relayWorkerScript('node')).toEqual({ file: RELAY_PROCESS_WORKER, name: 'bfwc-process' });
  });

  it('a PHP spawn is cold and never takes the primed Node spare', async () => {
    const created: WorkerKind[] = [];
    const worker = (kind: WorkerKind): WorkerLike => {
      created.push(kind);
      const made: WorkerLike = {
        onmessage: null,
        postMessage: (message) => (message as { type?: string }).type === 'prime' && queueMicrotask(() => made.onmessage?.({ data: { type: 'primed' } })),
        terminate: () => undefined,
      };
      return made;
    };
    const supply = new WorkerSupply(worker, new VfsSnapshots(new VirtualFileSystem()), true);
    supply.take('node'); // schedules a spare
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(supply.primes).toBe(1);
    const php = supply.take('php');
    expect(php.snapshot.pack).toBeDefined(); // cold: the whole snapshot
    expect(created).toEqual(['node', 'node', 'php']);
    expect(supply.warmStarts).toBe(0);
    const node = supply.take('node');
    expect(node.snapshot.pack).toBeUndefined(); // the spare, kept for Node
    expect(supply.warmStarts).toBe(1);
    supply.dispose();
  });

  it('the chained policy routes PHP, then Python, then Node, and merges foreign commands', () => {
    const fs = new VirtualFileSystem();
    const kinds = createPhpProcessKind({ phpVersion: '8.2' }, createPythonProcessKind());
    const context = { fs, cwd: '/', env: {} };
    expect(kinds.route('composer', ['install'], context)).toMatchObject({ kind: 'php' });
    expect(kinds.route('python3', ['a.py'], context)).toMatchObject({ kind: 'python' });
    expect(kinds.route('node', ['a.js'], context)).toMatchObject({ kind: 'node' });
    expect(kinds.startOptions('php')).toEqual({ php: { phpVersion: '8.2' } });
    expect(kinds.startOptions('python')).toMatchObject({ python: {} });
    const foreign = new RegExp(kinds.foreignCommands!);
    expect(['php', 'composer', 'python', 'pip'].every((name) => foreign.test(name))).toBe(true);
    expect(foreign.test('node')).toBe(false);
  });
});

describe('PHP next to Node in one runtime', () => {
  it('Node spawns php -r through child_process, and bfsh runs php, both in a PHP Worker', { timeout: 120_000 }, async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({
      'hello.php': '<?php echo "php says ", $argv[1], "\\n";',
      'spawn.js': `const child = require('child_process').spawn('php', ['-r', 'echo "from php -r ", PHP_MAJOR_VERSION >= 8 ? "ok" : "old";']); let out = ''; child.stdout.on('data', (d) => (out += d)); child.on('close', (code) => console.log('node got: ' + out.trim() + ' (exit ' + code + ')'));`,
    });
    const created: WorkerKind[] = [];
    const processes = new ProcessHost({
      fs,
      createWorker: (kind) => {
        created.push(kind);
        return kind === 'php' ? fakePhpWorker() : fakeWorker();
      },
      previewOrigin: 'https://app.test',
      previewBase: '/__bfwc/p1/',
      killGraceMs: 500,
      packageCache: false,
      warmWorker: false,
      kinds: createPhpProcessKind({}, createPythonProcessKind()),
    });
    const shell = processes.run('bfsh', ['-c', 'echo start && php hello.php from-shell && echo end']);
    expect(await readAll(shell.combinedOutput)).toBe('start\nphp says from-shell\nend\n');
    expect(await shell.wait()).toBe(0);
    const node = processes.run('node', ['spawn.js']);
    expect(await readAll(node.combinedOutput)).toBe('node got: from php -r ok (exit 0)\n');
    expect(await node.wait()).toBe(0);
    expect(created.filter((kind) => kind === 'php')).toHaveLength(2);
    processes.dispose();
  });
});
