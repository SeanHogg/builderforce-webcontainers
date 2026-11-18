import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, StartMessage } from '../src/node/protocol.js';
import { fakeWorker, readAll } from './helpers.js';

/** A process host whose workers record the start message the page posted (before the clone). */
function recordingHost(fs: VirtualFileSystem) {
  const starts: StartMessage[] = [];
  const createWorker = (): WorkerLike => {
    const worker = fakeWorker();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message) => {
      if ((message as HostToWorker).type === 'start') starts.push(message as StartMessage);
      post(message);
    };
    return worker;
  };
  const processes = new ProcessHost({ fs, createWorker, previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', packageCache: false });
  return { processes, starts };
}

const run = async (processes: ProcessHost, code: string) => {
  const proc = processes.run('node', ['-e', code]);
  const output = await readAll(proc.combinedOutput);
  expect(await proc.wait()).toBe(0);
  return output;
};

describe('process start-up snapshot', () => {
  it('does not rebuild the snapshot per spawn while the file system is unchanged', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'one', lib: { 'b.js': 'module.exports = 2;' } });
    const { processes, starts } = recordingHost(fs);
    expect(await run(processes, `console.log(require('fs').readFileSync('/a.txt', 'utf8'))`)).toBe('one\n');
    expect(await run(processes, `console.log(require('/lib/b.js'))`)).toBe('2\n');
    expect(processes.snapshots.builds).toBe(1);
    expect(starts[1]!.snapshot.pack).toBe(starts[0]!.snapshot.pack);
    expect(starts[1]!.snapshot.ops).toEqual([]);
    processes.dispose();
  });

  it('after an edit, a new process gets the same pack plus the edit, and sees it', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'one' });
    const { processes, starts } = recordingHost(fs);
    await run(processes, '');
    fs.writeFile('/a.txt', 'two');
    expect(await run(processes, `console.log(require('fs').readFileSync('/a.txt', 'utf8'))`)).toBe('two\n');
    expect(processes.snapshots.builds).toBe(1);
    expect(starts[1]!.snapshot.pack).toBe(starts[0]!.snapshot.pack);
    expect(starts[1]!.snapshot.ops).toEqual([{ op: 'write', path: '/a.txt', content: 'two' }]);
    processes.dispose();
  });

  it('a process starts with binary files, explicit empty directories and writes made by earlier processes', async () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/bin.dat', new Uint8Array([0, 1, 254, 255]));
    fs.mkdir('/empty');
    const { processes } = recordingHost(fs);
    await run(processes, `require('fs').writeFileSync('/made.txt', 'by first'); require('fs').mkdirSync('/made-dir')`);
    const output = await run(
      processes,
      `const fs = require('fs'); console.log([...fs.readFileSync('/bin.dat')].join(','), fs.statSync('/empty').isDirectory(), fs.readFileSync('/made.txt', 'utf8'), fs.existsSync('/made-dir'))`,
    );
    expect(output).toBe('0,1,254,255 true by first true\n');
    processes.dispose();
  });
});
