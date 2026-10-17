import { describe, expect, it } from 'vitest';
import { servePortRequest } from '../src/node/index.js';
import { host, readAll } from './helpers.js';

describe('ProcessHost (worker per process)', () => {
  it('runs node in a worker and syncs its writes back to the page', async () => {
    const { fs, processes } = host({ 'index.js': 'require("fs").writeFileSync("/out.txt", "from worker"); console.log("done")' });
    const proc = processes.run('node', ['index.js']);
    expect(await readAll(proc.combinedOutput)).toBe('done\n');
    expect(await proc.wait()).toBe(0);
    expect(fs.readText('/out.txt')).toBe('from worker');
  });

  it('routes /__port/<n>/ preview requests to a server in a worker and announces the listening server', async () => {
    const { processes } = host({
      'server.js': `require('http').createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => res.end(req.method + ' ' + req.url + ' ' + b)); }).listen(3000);`,
    });
    const ready = new Promise<[number, string]>((resolve) => processes.servers.onListening(({ port, url }) => resolve([port, url])));
    const proc = processes.run('node', ['server.js']);
    expect(await ready).toEqual([3000, 'https://app.test/__bfwc/p1/__port/3000/']);
    expect(processes.list()).toMatchObject([{ pid: proc.pid, command: 'node', args: ['server.js'], cwd: '/', ports: [3000] }]);
    const { message } = await servePortRequest(processes, { type: 'request', reqId: 7, path: '/__port/3000/api', search: '?q=1', method: 'POST', headers: {}, body: new TextEncoder().encode('data').buffer as ArrayBuffer });
    expect(message.status).toBe(200);
    expect(new TextDecoder().decode(message.body as ArrayBuffer)).toBe('POST /api?q=1 data');
    const missing = await servePortRequest(processes, { type: 'request', reqId: 8, path: '/__port/4000/', search: '' });
    expect(missing.message.status).toBe(502);
    proc.kill();
    expect(await proc.wait()).toBe(143);
    expect(processes.ports.has(3000)).toBe(false);
  });

  it('runs the shell, whose children (node) are separate workers seeing its writes', async () => {
    const { processes } = host();
    const proc = processes.run('bfsh', ['-c', `echo hi > a.txt && node -e "console.log(require('fs').readFileSync('a.txt', 'utf8').trim() + '!')" && nope`]);
    const output = await readAll(proc.combinedOutput);
    expect(output).toBe('hi!\nbfsh: command not found: nope\n');
    expect(await proc.wait()).toBe(127);
  });

  it('terminates a process that ignores the kill signal after the grace period', async () => {
    const { processes } = host({ 'stubborn.js': 'process.on("SIGTERM", () => console.log("ignoring")); setTimeout(() => {}, 3000);' }, 50);
    const proc = processes.run('node', ['stubborn.js']);
    const output = readAll(proc.combinedOutput);
    await new Promise((r) => setTimeout(r, 30));
    proc.kill();
    expect(await proc.wait()).toBe(143);
    expect(await output).toBe('ignoring\n');
  });
});
