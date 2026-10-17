import { describe, expect, it } from 'vitest';
import { createIpcPair } from '../../src/system/ipc.js';
import { runNode } from './helpers.js';

describe('message channels', () => {
  it('copies messages, holds early ones until someone listens, and closes both ends', async () => {
    const [parent, child] = createIpcPair();
    const payload = { n: 1, list: [1, 2] };
    parent.send(payload);
    payload.n = 2;
    const received: unknown[] = [];
    child.onMessage((message) => received.push(message));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([{ n: 1, list: [1, 2] }]);
    let closed = false;
    parent.onDisconnect(() => (closed = true));
    child.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(true);
    expect(parent.connected).toBe(false);
    expect(() => parent.send('late')).toThrow(/Channel closed/);
  });
});

describe('child_process.fork', () => {
  it('talks to the child both ways and sees it disconnect', async () => {
    const { output, code } = await runNode({
      'index.js': `
        const { fork } = require('child_process');
        const child = fork('./child.js', ['a']);
        child.on('message', (m) => {
          console.log('parent got', JSON.stringify(m));
          if (m.done) child.send({ bye: true });
        });
        child.on('disconnect', () => console.log('disconnected'));
        child.on('exit', (code) => console.log('exit', code));
        child.send({ hello: 'child' });
      `,
      'child.js': `
        console.log('child argv', process.argv[2], process.connected);
        process.on('message', (m) => {
          if (m.hello) process.send({ echo: m.hello, done: true });
          if (m.bye) process.disconnect();
        });
      `,
    });
    expect(code).toBe(0);
    expect(output).toContain('child argv a true');
    expect(output).toContain('parent got {"echo":"child","done":true}');
    expect(output).toContain('disconnected');
    expect(output).toContain('exit 0');
  });

  it('lets a child with no message listener exit on its own', async () => {
    const { output, code } = await runNode({
      'index.js': `require('child_process').fork('./child.js').on('exit', (c) => console.log('child exited', c));`,
      'child.js': `console.log('working');`,
    });
    expect(code).toBe(0);
    expect(output).toBe('working\nchild exited 0\n');
  });
});

describe('worker_threads', () => {
  it('runs a worker with workerData and exchanges messages with it', async () => {
    const { output, code } = await runNode({
      'index.js': `
        const { Worker, isMainThread } = require('worker_threads');
        console.log('main', isMainThread);
        const worker = new Worker('./worker.js', { workerData: { base: 40 } });
        worker.on('online', () => console.log('online'));
        worker.on('message', (m) => { console.log('result', m); worker.postMessage('stop'); });
        worker.on('exit', (code) => console.log('exit', code));
        worker.postMessage(2);
      `,
      'worker.js': `
        const { parentPort, workerData, isMainThread, threadId } = require('worker_threads');
        console.log('in worker', isMainThread, threadId > 0);
        parentPort.on('message', (m) => {
          if (m === 'stop') return parentPort.close();
          parentPort.postMessage(workerData.base + m);
        });
      `,
    });
    expect(code).toBe(0);
    expect(output).toContain('main true');
    expect(output).toContain('in worker false true');
    expect(output).toContain('online');
    expect(output).toContain('result 42');
    expect(output).toContain('exit 0');
  });

  it("reports a worker's uncaught error as the parent's 'error' event", async () => {
    const { output, code } = await runNode({
      'index.js': `
        const { Worker } = require('worker_threads');
        const worker = new Worker('throw new TypeError("bad input")', { eval: true });
        worker.on('error', (e) => console.log('caught', e.name, e.message));
        worker.on('exit', (code) => console.log('exit', code));
      `,
    });
    expect(code).toBe(0);
    expect(output).toContain('caught TypeError bad input');
    expect(output).toContain('exit 1');
    expect(output).not.toContain('Node.js v');
  });

  it('terminates a busy worker', async () => {
    const { output, code } = await runNode({
      'index.js': `
        const { Worker } = require('worker_threads');
        const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
        worker.on('online', async () => console.log('terminated', await worker.terminate()));
      `,
    });
    expect(code).toBe(0);
    expect(output).toBe('terminated 1\n');
  });
});
