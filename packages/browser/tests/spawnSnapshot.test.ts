import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker } from '../src/node/protocol.js';
import { fakeWorker, readAll } from './helpers.js';

type Recorded = Extract<HostToWorker, { type: 'start' | 'prime' }>;

/** A process host whose workers record the start/prime messages the page posted (before the clone). */
function recordingHost(fs: VirtualFileSystem, warmWorker: boolean) {
  const posted: Recorded[] = [];
  let created = 0;
  const createWorker = (): WorkerLike => {
    created++;
    const worker = fakeWorker();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message) => {
      const type = (message as HostToWorker).type;
      if (type === 'start' || type === 'prime') posted.push(message as Recorded);
      post(message);
    };
    return worker;
  };
  const processes = new ProcessHost({ fs, createWorker, previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', packageCache: false, warmWorker });
  const starts = () => posted.filter((m) => m.type === 'start');
  return { processes, posted, starts, created: () => created };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const run = async (processes: ProcessHost, code: string) => {
  const proc = processes.run('node', ['-e', code]);
  const output = await readAll(proc.combinedOutput);
  expect(await proc.wait()).toBe(0);
  await settle(); // let the host prime its spare, as time between real spawns does
  return output;
};

const READ_A = `console.log(require('fs').readFileSync('/a.txt', 'utf8'))`;

describe('process start-up snapshot (cold)', () => {
  it('does not rebuild the snapshot per spawn while the file system is unchanged', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'one', lib: { 'b.js': 'module.exports = 2;' } });
    const { processes, starts } = recordingHost(fs, false);
    expect(await run(processes, READ_A)).toBe('one\n');
    expect(await run(processes, `console.log(require('/lib/b.js'))`)).toBe('2\n');
    expect(processes.snapshots.builds).toBe(1);
    const [first, second] = starts();
    expect(second!.snapshot.pack).toBeInstanceOf(ArrayBuffer);
    expect(second!.snapshot.pack).toBe(first!.snapshot.pack);
    expect(second!.snapshot.ops).toEqual([]);
    processes.dispose();
  });

  it('after an edit, a new process gets the same pack plus the edit, and sees it', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'one' });
    const { processes, starts } = recordingHost(fs, false);
    await run(processes, '');
    fs.writeFile('/a.txt', 'two');
    expect(await run(processes, READ_A)).toBe('two\n');
    expect(processes.snapshots.builds).toBe(1);
    const [first, second] = starts();
    expect(second!.snapshot.pack).toBe(first!.snapshot.pack);
    expect(second!.snapshot.ops).toEqual([{ op: 'write', path: '/a.txt', content: 'two' }]);
    processes.dispose();
  });

  it('a process starts with binary files, explicit empty directories and writes made by earlier processes', async () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/bin.dat', new Uint8Array([0, 1, 254, 255]));
    fs.mkdir('/empty');
    const { processes } = recordingHost(fs, false);
    await run(processes, `require('fs').writeFileSync('/made.txt', 'by first'); require('fs').mkdirSync('/made-dir')`);
    const output = await run(
      processes,
      `const fs = require('fs'); console.log([...fs.readFileSync('/bin.dat')].join(','), fs.statSync('/empty').isDirectory(), fs.readFileSync('/made.txt', 'utf8'), fs.existsSync('/made-dir'))`,
    );
    expect(output).toBe('0,1,254,255 true by first true\n');
    processes.dispose();
  });
});

describe('process start-up snapshot (warm spare)', () => {
  it('primes a spare after a spawn; the next spawn takes it and sends only the changes since', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'one' });
    const { processes, posted, created } = recordingHost(fs, true);
    expect(await run(processes, READ_A)).toBe('one\n');
    expect(posted.map((m) => m.type)).toEqual(['start', 'prime']);
    fs.writeFile('/a.txt', 'two');
    expect(await run(processes, READ_A)).toBe('two\n');
    expect(processes.workers.warmStarts).toBe(1);
    expect(created()).toBe(3); // the first process, its spare (taken by the second), the next spare
    const second = posted[2]!;
    expect(second.type).toBe('start');
    expect(second.snapshot.pack).toBeUndefined();
    expect(second.snapshot.ops).toEqual([{ op: 'write', path: '/a.txt', content: 'two' }]);
    expect(processes.snapshots.builds).toBe(1);
    processes.dispose();
  });

  it('a shell and its children start warm and still see each other\'s writes', async () => {
    const fs = new VirtualFileSystem();
    const { processes } = recordingHost(fs, true);
    await run(processes, '');
    const proc = processes.run('bfsh', ['-c', `echo hi > a.txt && node -e "console.log(require('fs').readFileSync('a.txt', 'utf8').trim() + '!')"`]);
    expect(await readAll(proc.combinedOutput)).toBe('hi!\n');
    expect(await proc.wait()).toBe(0);
    expect(processes.workers.warmStarts).toBeGreaterThanOrEqual(1);
    processes.dispose();
  });

  it('drops a spare that fell too far behind and starts cold from a fresh pack', async () => {
    const fs = new VirtualFileSystem();
    const { processes, starts } = recordingHost(fs, true);
    await run(processes, '');
    for (let i = 0; i < 1100; i++) fs.writeFile(`/gen/f${i}.txt`, String(i)); // more ops than a delta may carry
    expect(await run(processes, `console.log(require('fs').readFileSync('/gen/f1099.txt', 'utf8'))`)).toBe('1099\n');
    expect(processes.workers.warmStarts).toBe(0);
    expect(starts()[1]!.snapshot.pack).toBeInstanceOf(ArrayBuffer);
    expect(processes.snapshots.builds).toBe(2);
    processes.dispose();
  });
});
