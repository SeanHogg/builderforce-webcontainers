/**
 * The Python socket seam over a stand-in virtual TCP transport (an in-memory
 * upper-casing echo server on 5432): the asyncio face, the blocking face (what
 * pg8000 and redis-py use) through JSPI's `run_sync`, refusals, timeouts,
 * non-blocking reads and half-close. Then the dial transport the worker will
 * use, over real byte channels and over the process protocol's dial messages.
 */
import { describe, expect, it } from 'vitest';
import { createChannelPair, type ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from '../src/node/protocol.js';
import { createChannelTransport, createDialTransport, installVirtualSockets, type VirtualTcpTransport } from '../src/runtimes/python/index.js';
import { installBfwcPackage } from '../src/runtimes/python/py/installBfwcPackage.js';
import { loadTestPyodide } from './python-helpers.js';

/** Echoes every byte back, upper-cased; `connect` to any port but 5432 is refused. */
function echoTransport(): VirtualTcpTransport & { closed: number[]; shut: number[]; received: string[] } {
  const inboxes = new Map<number, { queue: Uint8Array[]; wake?: () => void; closed: boolean }>();
  let next = 1;
  const record = { closed: [] as number[], shut: [] as number[], received: [] as string[] };
  return {
    ...record,
    async connect(_host, port) {
      if (port !== 5432) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
      inboxes.set(next, { queue: [], closed: false });
      return next++;
    },
    send(connId, data) {
      const text = new TextDecoder().decode(data);
      record.received.push(text);
      const inbox = inboxes.get(connId)!;
      inbox.queue.push(new TextEncoder().encode(text.toUpperCase()));
      inbox.wake?.();
    },
    async recv(connId, max) {
      const inbox = inboxes.get(connId)!;
      while (!inbox.queue.length && !inbox.closed) await new Promise<void>((resolve) => (inbox.wake = resolve));
      const chunk = inbox.queue.shift();
      if (!chunk) return null;
      if (chunk.byteLength > max) inbox.queue.unshift(chunk.subarray(max));
      return chunk.subarray(0, max);
    },
    shutdown: (connId) => void record.shut.push(connId),
    close(connId) {
      record.closed.push(connId);
      const inbox = inboxes.get(connId);
      if (inbox) {
        inbox.closed = true;
        inbox.wake?.();
      }
    },
  };
}

const run = async (pyodide: Awaited<ReturnType<typeof loadTestPyodide>>, code: string) => (await pyodide.runPythonAsync(code)) as string;

describe('Python virtual sockets', () => {
  it('asyncio streams and blocking sockets reach the transport, with refusals, timeouts and half-close', { timeout: 120_000 }, async () => {
    const pyodide = await loadTestPyodide();
    installBfwcPackage(pyodide);
    const transport = echoTransport();
    installVirtualSockets(pyodide, transport);

    expect(
      await run(pyodide, `
from bfwc.vsocket import open_connection
reader, writer = await open_connection("localhost", 5432)
writer.write(b"select 1\\n")
await writer.drain()
line = await reader.readline()
writer.write(b"bye\\n")
writer.close()          # sends what was written before closing
await writer.wait_closed()
line.decode()
`),
    ).toBe('SELECT 1\n');
    expect(transport.received).toContain('bye\n');

    expect(await run(pyodide, 'from pyodide.ffi import can_run_sync\nstr(can_run_sync())')).toBe('True');
    expect(
      await run(pyodide, `
import socket
sock = socket.create_connection(("localhost", 5432), 5)
stream = sock.makefile("rwb")
stream.write(b"hello pg\\n"); stream.flush()
reply = stream.readline()
sock.close()
reply.decode()
`),
    ).toBe('HELLO PG\n');

    // redis-py style: getaddrinfo, then socket.socket(...).connect(...)
    expect(
      await run(pyodide, `
import socket
family, kind, proto, _, address = socket.getaddrinfo("cache", 5432)[0]
sock = socket.socket(family, kind, proto)
sock.connect(address)
sock.sendall(b"ping")
answer = sock.recv(16)
sock.close()
answer.decode()
`),
    ).toBe('PING');

    expect(
      await run(pyodide, `
import socket, errno
results = []
try:
    socket.create_connection(("localhost", 9999))
except ConnectionRefusedError as error:
    results.append("refused %s" % (error.errno == errno.ECONNREFUSED))
results.append("connect_ex %s" % (socket.socket().connect_ex(("localhost", 9999)) == errno.ECONNREFUSED))
sock = socket.create_connection(("localhost", 5432))
sock.settimeout(0.05)
try:
    sock.recv(10)
except socket.timeout:
    results.append("timeout")
sock.setblocking(False)
try:
    sock.recv(10)
except BlockingIOError:
    results.append("would block")
sock.setblocking(True)
sock.sendall(b"late")
results.append(sock.recv(10).decode())
sock.shutdown(socket.SHUT_WR)
try:
    sock.sendall(b"more")
except BrokenPipeError:
    results.append("half-closed")
sock.close()
" | ".join(results)
`),
    ).toBe('refused True | connect_ex True | timeout | would block | LATE | half-closed');
    expect(transport.shut.length).toBe(1);
    expect(transport.closed.length).toBeGreaterThanOrEqual(3);

    // An asyncio reader waiting while its writer closes: it reads end of stream, it does not hang.
    expect(
      await run(pyodide, `
import asyncio
from bfwc.vsocket import open_connection
reader, writer = await open_connection("localhost", 5432)
pending = asyncio.ensure_future(reader.read(10))
await asyncio.sleep(0)
writer.close()
await writer.wait_closed()
data = await asyncio.wait_for(pending, 5)
repr(data)
`),
    ).toBe("b''");
  });
});

/** A server end on `port` that upper-cases what it reads, crediting what it consumed. */
function upperServer(): (port: number) => Promise<ByteChannel | undefined> {
  return async (port) => {
    if (port !== 5432) return undefined;
    const [client, server] = createChannelPair();
    server.onData((data) => {
      server.consumed(data.byteLength);
      server.send(new TextEncoder().encode(new TextDecoder().decode(data).toUpperCase()));
    });
    return client;
  };
}

describe('the dial transport', () => {
  it('connects, sends, receives in pieces, credits reads, and refuses a closed port', async () => {
    const transport = createChannelTransport(upperServer());
    await expect(transport.connect('localhost', 1)).rejects.toThrow('ECONNREFUSED');
    await expect(transport.connect('example.com', 5432)).rejects.toThrow('only localhost');
    const conn = await transport.connect('127.0.0.1', 5432);
    await transport.send(conn, new TextEncoder().encode('abcdef'));
    const first = await transport.recv(conn, 4);
    const rest = await transport.recv(conn, 100);
    expect(new TextDecoder().decode(first!) + new TextDecoder().decode(rest!)).toBe('ABCDEF');
    transport.close(conn);
    await expect(transport.recv(conn, 1)).rejects.toThrow('closed');
  });

  it('holds a sender back while a slow reader is behind, and releases it as the reader catches up', async () => {
    let server!: ByteChannel;
    const transport = createChannelTransport(async () => {
      const [client, end] = createChannelPair();
      server = end;
      server.manualFlowControl(); // a slow reader: credits only when the test says
      return client;
    }, 1024);
    const conn = await transport.connect('localhost', 1);
    let received = 0;
    server.onData((data) => (received += data.byteLength));
    await transport.send(conn, new Uint8Array(1000)); // under the mark: no wait
    let released = false;
    const blocked = Promise.resolve(transport.send(conn, new Uint8Array(1000))).then(() => (released = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toBe(2000);
    expect(released).toBe(false);
    server.consumed(1500); // 500 in flight now: room again
    await blocked;
    expect(released).toBe(true);
  });

  it('a local close ends a pending recv (end of stream) and a waiting send', async () => {
    let server!: ByteChannel;
    const transport = createChannelTransport(async () => {
      const [client, end] = createChannelPair();
      server = end;
      server.manualFlowControl();
      return client;
    }, 10);
    const conn = await transport.connect('localhost', 1);
    const reading = transport.recv(conn, 100);
    const sending = Promise.resolve(transport.send(conn, new Uint8Array(100)));
    transport.close(conn);
    expect(await reading).toBeNull();
    await sending; // released, not stranded
    expect(server).toBeDefined();
  });

  it("speaks the process protocol's dial messages", async () => {
    const posted: WorkerToHost[] = [];
    const { transport, receive } = createDialTransport((message) => posted.push(message));
    const connecting = transport.connect('localhost', 5432);
    expect(posted).toEqual([{ type: 'dial', connId: 1, port: 5432 }]);
    expect(receive({ type: 'dial-result', connId: 1, ok: true } satisfies HostToWorker)).toBe(true);
    const conn = await connecting;
    await transport.send(conn, new TextEncoder().encode('hi'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toContainEqual({ type: 'dial-data', connId: 1, data: new TextEncoder().encode('hi') });
    receive({ type: 'dial-data', connId: 1, data: new TextEncoder().encode('HI') });
    expect(new TextDecoder().decode((await transport.recv(conn, 10))!)).toBe('HI');
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toContainEqual({ type: 'dial-ack', connId: 1, bytes: 2 });
    receive({ type: 'dial-close', connId: 1 });
    expect(await transport.recv(conn, 10)).toBeNull();
    expect(receive({ type: 'fs', ops: [] })).toBe(false);
    const refused = transport.connect('localhost', 9);
    receive({ type: 'dial-result', connId: 2, ok: false });
    await expect(refused).rejects.toThrow('ECONNREFUSED');
  });
});
