import { describe, expect, it } from 'vitest';
import { host, readAll } from './helpers.js';

describe('message channels across process Workers', () => {
  it('relays child_process.fork messages between a parent Worker and its child Worker', async () => {
    const { processes } = host({
      'index.js': `
        const child = require('child_process').fork('./child.js');
        child.on('message', (m) => { console.log('parent got', m.n); child.disconnect(); });
        child.on('exit', (code) => console.log('child exit', code));
        child.send({ n: 20 });
      `,
      'child.js': `process.on('message', (m) => process.send({ n: m.n + 1 }));`,
    });
    const proc = processes.run('node', ['index.js']);
    const output = await readAll(proc.combinedOutput);
    expect(output).toContain('parent got 21');
    expect(output).toContain('child exit 0');
    expect(await proc.wait()).toBe(0);
  });

  it('runs a worker_threads Worker in its own process Worker', async () => {
    const { processes } = host({
      'index.js': `
        const { Worker } = require('worker_threads');
        const worker = new Worker('./worker.js', { workerData: [1, 2, 3] });
        worker.on('message', (sum) => { console.log('sum', sum); worker.terminate(); });
      `,
      'worker.js': `
        const { parentPort, workerData } = require('worker_threads');
        parentPort.postMessage(workerData.reduce((a, b) => a + b, 0));
      `,
    });
    const proc = processes.run('node', ['index.js']);
    expect(await readAll(proc.combinedOutput)).toContain('sum 6');
    expect(await proc.wait()).toBe(0);
  });
});
