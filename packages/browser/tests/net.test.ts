/**
 * Virtual TCP between processes: `net.createServer` in one process Worker,
 * `net.connect` in another, bytes relayed by the page (connectionRelay.ts).
 */
import { describe, expect, it } from 'vitest';
import { collect, host, readAll } from './helpers.js';

const ECHO_SERVER = `
  const net = require('net');
  net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  }).listen(7000, () => console.log('listening'));
`;

const listening = (processes: ReturnType<typeof host>['processes'], port: number) =>
  new Promise<void>((resolve) => {
    if (processes.ports.has(port)) return resolve();
    const stop = processes.ports.watch((event) => {
      if (event.type === 'open' && event.port === port) {
        stop();
        resolve();
      }
    });
  });

describe('net: virtual TCP between processes', () => {
  it('echoes bytes between a client and a server in two processes', async () => {
    const { processes } = host({
      'server.js': ECHO_SERVER,
      'client.js': `
        const net = require('net');
        const socket = net.createConnection({ port: 7000, host: 'localhost' }, () => {
          console.log('connected', socket.remoteAddress, socket.remotePort, typeof socket.localPort);
          socket.setNoDelay(true);
          socket.setKeepAlive(true);
          socket.write('hello', () => console.log('written'));
        });
        socket.on('data', (data) => {
          console.log('echo', Buffer.isBuffer(data), data.toString());
          socket.end();
        });
        socket.on('close', () => console.log('closed'));
      `,
    });
    const server = processes.run('node', ['server.js']);
    await listening(processes, 7000);
    const client = processes.run('node', ['client.js']);
    expect(await readAll(client.combinedOutput)).toBe('connected 127.0.0.1 7000 number\nwritten\necho true hello\nclosed\n');
    expect(await client.wait()).toBe(0);
    server.kill('SIGKILL');
    await server.wait();
  });

  it('applies backpressure: write() returns false until the reader catches up, then drain', async () => {
    const { processes } = host({
      'server.js': `
        const net = require('net');
        net.createServer((socket) => {
          let total = 0;
          socket.pause();
          setTimeout(() => socket.resume(), 100);
          socket.on('data', (chunk) => {
            total += chunk.length;
            if (total === 1048576) { console.log('received', total); socket.end(); }
          });
        }).listen(7001);
      `,
      'client.js': `
        const net = require('net');
        const socket = net.connect(7001, '127.0.0.1');
        const chunk = Buffer.alloc(16384, 7);
        let sent = 0, refused = 0, drains = 0;
        socket.on('drain', () => drains++);
        const pump = () => {
          while (sent < 64) {
            sent++;
            if (!socket.write(chunk)) { refused++; return socket.once('drain', pump); }
          }
        };
        socket.on('connect', pump);
        socket.on('end', () => console.log('backpressure', refused > 0, drains > 0));
        socket.resume();
      `,
    });
    const server = processes.run('node', ['server.js']);
    const serverOutput = readAll(server.combinedOutput);
    await listening(processes, 7001);
    const client = processes.run('node', ['client.js']);
    expect(await readAll(client.combinedOutput)).toBe('backpressure true true\n');
    server.kill('SIGKILL');
    await server.wait();
    expect(await serverOutput).toBe('received 1048576\n');
  });

  it('refuses a port nothing listens on, and any host other than localhost, with ECONNREFUSED', async () => {
    const { processes } = host({
      'client.js': `
        const net = require('net');
        net.connect(5999).on('error', (e) => {
          console.log(e.code, e.syscall, e.port);
          net.connect({ port: 80, host: 'example.com' }).on('error', (e2) => console.log(e2.code, /localhost/.test(e2.message)));
        });
      `,
    });
    const client = processes.run('node', ['client.js']);
    expect(await readAll(client.combinedOutput)).toBe('ECONNREFUSED connect 5999\nECONNREFUSED true\n');
  });

  it('closes the connection when the server process exits, and when the client process exits', async () => {
    const { processes } = host({
      'server.js': `
        require('net').createServer((socket) => {
          console.log('accepted');
          socket.on('close', () => console.log('client gone'));
          socket.resume();
        }).listen(7002);
      `,
      'client.js': `
        const socket = require('net').connect(7002);
        socket.on('connect', () => console.log('connected'));
        socket.on('end', () => console.log('end'));
        socket.on('close', () => console.log('close'));
        socket.resume();
      `,
      'idle-client.js': `
        const socket = require('net').connect(7002);
        socket.on('connect', () => console.log('connected'));
        socket.resume();
      `,
    });
    let server = processes.run('node', ['server.js']);
    let serverOutput = collect(server.combinedOutput);
    await listening(processes, 7002);
    const client = processes.run('node', ['client.js']);
    const clientOutput = collect(client.combinedOutput);
    await Promise.all([clientOutput.until('connected'), serverOutput.until('accepted')]);
    server.kill('SIGKILL');
    await server.wait();
    expect(await clientOutput.done).toBe('connected\nend\nclose\n');
    expect(await client.wait()).toBe(0);

    server = processes.run('node', ['server.js']);
    serverOutput = collect(server.combinedOutput);
    await listening(processes, 7002);
    const idle = processes.run('node', ['idle-client.js']);
    await Promise.all([collect(idle.combinedOutput).until('connected'), serverOutput.until('accepted')]);
    idle.kill('SIGKILL');
    await idle.wait();
    await serverOutput.until('client gone');
    server.kill('SIGKILL');
    await server.wait();
    expect(await serverOutput.done).toBe('accepted\nclient gone\n');
  });

  it('a page listener that never credits what it reads does not stall the writer (credits are automatic by default)', async () => {
    const { processes } = host({
      'client.js': `
        const socket = require('net').connect(7003);
        const chunk = Buffer.alloc(65536, 1);
        let sent = 0;
        const pump = () => {
          while (sent < 32) {
            sent++;
            if (!socket.write(chunk)) return socket.once('drain', pump);
          }
          socket.end(() => console.log('wrote', sent * chunk.length));
        };
        socket.on('connect', pump);
      `,
    });
    let received = 0;
    processes.ports.listen(7003, async () => ({ status: 502, headers: {}, body: new ReadableStream() }), undefined, (socket) => socket.onData((data) => (received += data.byteLength)));
    const client = processes.run('node', ['client.js']);
    expect(await readAll(client.combinedOutput)).toBe('wrote 2097152\n');
    expect(received).toBe(2097152);
  });
});
