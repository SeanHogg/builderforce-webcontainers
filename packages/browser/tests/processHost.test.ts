import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import { createWorkerProcess } from '../src/node/workerProcess.js';
import { servePortRequest } from '../src/node/index.js';
import type { HostToWorker } from '../src/node/protocol.js';

/** A Worker that runs the process in this thread, with structured-clone messaging like the real thing. */
function fakeWorker(): WorkerLike {
  let alive = true;
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const copy = structuredClone(message) as HostToWorker;
      queueMicrotask(() => alive && proc.receive(copy));
    },
    terminate() {
      alive = false;
    },
  };
  const proc = createWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  return worker;
}

function host(files: Record<string, string> = {}, killGraceMs = 2000) {
  const fs = new VirtualFileSystem();
  fs.mount(files);
  const processes = new ProcessHost({ fs, createWorker: fakeWorker, previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', previewUrl: 'https://app.test/__bfwc/p1/', killGraceMs, packageCache: false });
  return { fs, processes };
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

describe('ProcessHost (worker per process)', () => {
  it('runs node in a worker and syncs its writes back to the page', async () => {
    const { fs, processes } = host({ 'index.js': 'require("fs").writeFileSync("/out.txt", "from worker"); console.log("done")' });
    const proc = processes.spawn('node', ['index.js']);
    expect(await readAll(proc.output)).toBe('done\n');
    expect(await proc.exit).toBe(0);
    expect(fs.readText('/out.txt')).toBe('from worker');
  });

  it('routes /__port/<n>/ preview requests to a server in a worker and announces server-ready', async () => {
    const { processes } = host({
      'server.js': `require('http').createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => res.end(req.method + ' ' + req.url + ' ' + b)); }).listen(3000);`,
    });
    const ready = new Promise<[number, string]>((resolve) => processes.on('server-ready', (port, url) => resolve([port, url])));
    const proc = processes.spawn('node', ['server.js']);
    expect(await ready).toEqual([3000, 'https://app.test/__bfwc/p1/__port/3000/']);
    const { message } = await servePortRequest(processes, { type: 'request', reqId: 7, path: '/__port/3000/api', search: '?q=1', method: 'POST', headers: {}, body: new TextEncoder().encode('data').buffer as ArrayBuffer });
    expect(message.status).toBe(200);
    expect(new TextDecoder().decode(message.body as ArrayBuffer)).toBe('POST /api?q=1 data');
    const missing = await servePortRequest(processes, { type: 'request', reqId: 8, path: '/__port/4000/', search: '' });
    expect(missing.message.status).toBe(502);
    proc.kill();
    expect(await proc.exit).toBe(143);
    expect(processes.ports.has(3000)).toBe(false);
  });

  it('runs the shell, whose children (node) are separate workers seeing its writes', async () => {
    const { processes } = host();
    const proc = processes.spawn('jsh', ['-c', `echo hi > a.txt && node -e "console.log(require('fs').readFileSync('a.txt', 'utf8').trim() + '!')" && nope`]);
    const output = await readAll(proc.output);
    expect(output).toBe('hi!\njsh: command not found: nope\n');
    expect(await proc.exit).toBe(127);
  });

  it('terminates a process that ignores the kill signal after the grace period', async () => {
    const { processes } = host({ 'stubborn.js': 'process.on("SIGTERM", () => console.log("ignoring")); setTimeout(() => {}, 3000);' }, 50);
    const proc = processes.spawn('node', ['stubborn.js']);
    const output = readAll(proc.output);
    await new Promise((r) => setTimeout(r, 30));
    proc.kill();
    expect(await proc.exit).toBe(143);
    expect(await output).toBe('ignoring\n');
  });
});
