/**
 * Request-driven Python apps on the runtime's virtual ports, on a real
 * Pyodide: ASGI (lifespan, streaming, disconnects), WSGI, `uvicorn.run` from
 * `__main__`, port conflicts, files a server holds open, the python provider
 * in an application — and, when the network is there, FastAPI and Flask.
 */
import { describe, expect, it } from 'vitest';
import { startApplicationRuntime, type NodeServiceHost } from '../src/app.js';
import { VfsSnapshots, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from '../src/node/protocol.js';
import { createWorkerProcess } from '../src/node/workerProcess.js';
import { createPythonProvider, createPythonWorkerProcess } from '../src/runtimes/python/index.js';
import { collect, loadTestPyodide, online, pythonHost, readAll, request, serving, until } from './python-helpers.js';

const SLOW = 120_000;

const ASGI_APP = `
import json
from pyodide.ffi import can_run_sync

async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                scope["state"]["greeting"] = "hi"
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    body = (await receive())["body"]
    if scope["path"] == "/file":
        payload = open("live.txt").read().encode()
    elif scope["path"] == "/jspi":
        payload = str(can_run_sync()).encode()
    else:
        payload = json.dumps({
            "method": scope["method"], "path": scope["path"], "query": scope["query_string"].decode(),
            "body": body.decode(), "greeting": scope["state"].get("greeting"),
            "header": dict(scope["headers"]).get(b"x-test", b"").decode(),
        }).encode()
    await send({"type": "http.response.start", "status": 201, "headers": [(b"content-type", b"application/json"), (b"set-cookie", b"a=1"), (b"set-cookie", b"b=2")]})
    await send({"type": "http.response.body", "body": payload[:5], "more_body": True})
    await send({"type": "http.response.body", "body": payload[5:]})
`;

const WSGI_APP = `
def application(environ, start_response):
    length = int(environ.get("CONTENT_LENGTH") or 0)
    body = environ["wsgi.input"].read(length).decode()
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [environ["REQUEST_METHOD"].encode(), b" ", environ["PATH_INFO"].encode("latin-1"), b"?", environ["QUERY_STRING"].encode(), b" ", body.encode(), b" ", environ.get("HTTP_X_TEST", "").encode()]
`;

describe('ASGI apps', () => {
  it('serve with lifespan, a streamed body and repeated headers; see page edits; run_sync works in a request', { timeout: SLOW }, async () => {
    const { fs, ports, python } = pythonHost({ 'api/main.py': ASGI_APP, 'api/live.txt': 'v1' });
    const proc = python.run('uvicorn', ['--reload', 'main:app', '--port', '8000'], { cwd: '/api' });
    await serving(ports, 8000, proc, collect(proc.combinedOutput));
    const response = await request(ports, 8000, 'POST', '/items%20x?q=1', 'payload', { 'x-test': 'yes' });
    expect(response.status).toBe(201);
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(JSON.parse(response.text)).toEqual({ method: 'POST', path: '/items x', query: 'q=1', body: 'payload', greeting: 'hi', header: 'yes' });
    expect((await request(ports, 8000, 'GET', '/jspi')).text).toBe('True');
    expect((await request(ports, 8000, 'GET', '/file')).text).toBe('v1');
    fs.writeFile('/api/live.txt', 'v2');
    await until(async () => (await request(ports, 8000, 'GET', '/file')).text === 'v2');
    proc.kill();
    expect(await proc.wait()).toBe(143);
    expect(ports.has(8000)).toBe(false);
    python.dispose();
  });

  it('serve an app that ignores the lifespan scope (it returns), instead of hanging', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({
      'plain.py': 'async def app(scope, receive, send):\n    if scope["type"] != "http":\n        return\n    await send({"type": "http.response.start", "status": 200, "headers": []})\n    await send({"type": "http.response.body", "body": b"plain"})\n',
    });
    const proc = python.run('python', ['-m', 'uvicorn', 'plain:app', '--port', '8004']);
    await serving(ports, 8004, proc, collect(proc.combinedOutput));
    expect((await request(ports, 8004, 'GET', '/')).text).toBe('plain');
    proc.kill();
    await proc.wait();
    python.dispose();
  });

  it('uvicorn.run(app) in __main__ serves through the runtime', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({
      'run.py': 'import os, uvicorn\nfrom plain import app\nif __name__ == "__main__":\n    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]))\n    print("not reached")\n',
      'plain.py': 'async def app(scope, receive, send):\n    if scope["type"] != "http":\n        return\n    await send({"type": "http.response.start", "status": 200, "headers": []})\n    await send({"type": "http.response.body", "body": b"from __main__"})\n',
    });
    const proc = python.run('python', ['run.py'], { env: { PORT: '8005' } });
    const log = collect(proc.combinedOutput);
    await serving(ports, 8005, proc, log);
    expect((await request(ports, 8005, 'GET', '/')).text).toBe('from __main__');
    proc.kill();
    await proc.wait();
    expect(log.text()).not.toContain('not reached');
    python.dispose();
  });

  it('send a file a server holds open to the page while it is still open', { timeout: SLOW }, async () => {
    const { fs, ports, python } = pythonHost({
      'logger.py': 'log = open("server.log", "w")\nasync def app(scope, receive, send):\n    if scope["type"] != "http":\n        return\n    log.write("request\\n"); log.flush()\n    await send({"type": "http.response.start", "status": 204, "headers": []})\n    await send({"type": "http.response.body", "body": b""})\n',
    });
    const proc = python.run('uvicorn', ['logger:app', '--port', '8006']);
    await serving(ports, 8006, proc, collect(proc.combinedOutput));
    await request(ports, 8006, 'GET', '/');
    await until(() => fs.readText('/server.log') === 'request\n');
    proc.kill();
    await proc.wait();
    python.dispose();
  });
});

describe('WSGI apps', () => {
  it('serve (gunicorn, and uvicorn --interface wsgi)', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'wsgi.py': WSGI_APP });
    const proc = python.run('gunicorn', ['-b', '0.0.0.0:8001', 'wsgi:application']);
    await serving(ports, 8001, proc, collect(proc.combinedOutput));
    expect(await request(ports, 8001, 'PUT', '/a/%C3%A9?z=9', 'data', { 'x-test': 't' })).toMatchObject({ status: 200, text: 'PUT /a/é?z=9 data t' });
    proc.kill('SIGKILL');
    expect(await proc.wait()).toBe(137);
    const viaUvicorn = python.run('uvicorn', ['--interface', 'wsgi', 'wsgi:application', '--port', '8007']);
    await serving(ports, 8007, viaUvicorn, collect(viaUvicorn.combinedOutput));
    expect((await request(ports, 8007, 'GET', '/u')).text).toBe('GET /u?  ');
    viaUvicorn.kill();
    await viaUvicorn.wait();
    python.dispose();
  });

  it('answer 500 with the traceback when the app raises, and keep serving', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'boom.py': 'def application(environ, start_response):\n    if environ["PATH_INFO"] == "/bad":\n        raise RuntimeError("kaput")\n    start_response("204 No Content", [])\n    return []\n' });
    const proc = python.run('waitress-serve', ['--port=8002', 'boom:application']);
    await serving(ports, 8002, proc, collect(proc.combinedOutput));
    const bad = await request(ports, 8002, 'GET', '/bad');
    expect(bad.status).toBe(500);
    expect(bad.text).toContain('RuntimeError: kaput');
    expect((await request(ports, 8002, 'GET', '/ok')).status).toBe(204);
    proc.kill();
    await proc.wait();
    python.dispose();
  });
});

describe('ports', () => {
  it('refuse a port another server already holds', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'wsgi.py': WSGI_APP });
    ports.listen(8003, async () => ({ status: 200, headers: {}, body: new ReadableStream() }));
    const proc = python.run('gunicorn', ['-b', ':8003', 'wsgi:application']);
    expect(await readAll(proc.combinedOutput)).toContain('address already in use');
    expect(await proc.wait()).toBe(1);
    python.dispose();
  });

  it('two servers racing for one port: one serves, the other exits with EADDRINUSE', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'wsgi.py': WSGI_APP });
    const first = python.run('gunicorn', ['-b', ':8008', 'wsgi:application']);
    const second = python.run('gunicorn', ['-b', ':8008', 'wsgi:application']);
    const logs = [collect(first.combinedOutput), collect(second.combinedOutput)];
    const loser = await Promise.race([first.wait().then(() => 0), second.wait().then(() => 1)]);
    expect(await [first, second][loser]!.wait()).toBe(1);
    expect(logs[loser]!.text()).toContain('address already in use');
    expect((await request(ports, 8008, 'GET', '/race')).status).toBe(200);
    [first, second][1 - loser]!.kill();
    python.dispose();
  });
});

describe('the python provider in an application', () => {
  it('starts a Python API as a service, ready when its port opens, and stops it', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'api/wsgi.py': WSGI_APP });
    const url = (port: number) => `https://app.test/__bfwc/p1/__port/${port}/`;
    // The runtime as a provider host: Python commands go to Python Workers by themselves.
    const runtimeHost: NodeServiceHost = {
      run: (command, args, options) => python.run(command, args, options),
      onServerListening: (listener) => python.servers.onListening(listener),
      onPortChange: (listener) => python.servers.onPortChange(listener),
      listProcesses: () => python.list(),
    };
    const app = startApplicationRuntime(
      { projectId: 'p1', services: [{ id: 'api', type: 'application', runtime: 'python', root: '/api', command: 'gunicorn', args: ['wsgi:application', '-b', ':8020'], port: 8020 }] },
      { providers: [createPythonProvider(runtimeHost)] },
    );
    await app.start();
    expect(app.getService('api')).toMatchObject({ state: expect.stringMatching(/^(ready|running)$/), url: url(8020) });
    expect((await request(ports, 8020, 'GET', '/health')).text).toBe('GET /health?  ');
    await app.dispose();
    expect(ports.has(8020)).toBe(false);
    python.dispose();
  });
});

describe('Python next to Node in one runtime', () => {
  it('bfsh runs python, and Node spawns it, through the process host', { timeout: SLOW }, async () => {
    const { python: processes } = pythonHost({
      'hello.py': 'import sys\nprint("py says", sys.argv[1])\n',
      'spawn.js': `const child = require('child_process').spawn('python', ['hello.py', 'from-node']); let out = ''; child.stdout.on('data', (d) => (out += d)); child.on('close', (code) => console.log('node got: ' + out.trim() + ' (exit ' + code + ')'));`,
    });
    const shell = processes.run('bfsh', ['-c', 'echo start && python hello.py from-shell && echo end']);
    expect(await readAll(shell.combinedOutput)).toBe('start\npy says from-shell\nend\n');
    expect(await shell.wait()).toBe(0);
    const node = processes.run('node', ['spawn.js']);
    expect(await readAll(node.combinedOutput)).toBe('node got: py says from-node (exit 0)\n');
    expect(await node.wait()).toBe(0);
    processes.dispose();
  });

});

/** Drive one process Worker directly: what it posts, and a way to wait for a message. */
function driven(create: (post: (message: WorkerToHost) => void) => { receive(message: HostToWorker): void }) {
  const posted: WorkerToHost[] = [];
  const waiters: Array<() => void> = [];
  const worker = create((message) => {
    posted.push(structuredClone(message));
    for (const wake of waiters.splice(0)) wake();
  });
  /** The first posted message of `type` that `matches`, once it is posted. */
  const next = async (type: WorkerToHost['type'], matches: (message: WorkerToHost) => boolean = () => true) => {
    const find = () => posted.find((message) => message.type === type && matches(message));
    while (!find()) await new Promise<void>((resolve) => waiters.push(resolve));
    return find()!;
  };
  /** Everything written to stdout so far. */
  const stdout = () => posted.map((message) => (message.type === 'stdout' ? String(message.data) : '')).join('');
  const untilStdout = async (text: string, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (!stdout().includes(text)) {
      if (Date.now() > deadline) throw new Error(`No "${text.trim()}" on stdout; posted: ${JSON.stringify(posted.map((message) => (message.type === 'stdout' || message.type === 'stderr' ? `${message.type}:${String(message.data)}` : message.type)))}`);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
    }
  };
  return { posted, next, stdout, untilStdout, receive: (message: HostToWorker) => worker.receive(structuredClone(message)) };
}

function startMessage(command: string, args: string[], files: Record<string, string>): HostToWorker {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return { type: 'start', pid: 1, command, args, cwd: '/', env: {}, snapshot: new VfsSnapshots(fs).snapshot(), ports: [], previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', packageCache: false };
}

describe('listen-failed (the page refused a listen)', () => {
  it("a Node server hears 'error' (EADDRINUSE), never 'listening', and a Vite-style fallback to the next port works", async () => {
    const node = driven((post) => createWorkerProcess({ post, fetch: (input, init) => fetch(input, init) }));
    const server = `
      const http = require('http');
      const listen = (port) => {
        const server = http.createServer((q, s) => s.end('node on ' + port));
        server.on('error', (e) => {
          console.log('error', e.code, e.errno, e.syscall, e.address, e.port, 'listening=' + server.listening);
          if (e.code === 'EADDRINUSE') listen(port + 1);
        });
        server.listen(port, () => console.log('listening on', port));
      };
      listen(8030);`;
    node.receive(startMessage('node', ['server.js'], { 'server.js': server }));
    const first = await node.next('listen', (message) => message.type === 'listen' && message.port === 8030);
    node.receive({ type: 'listen-failed', port: 8030, message: 'listen EADDRINUSE: address already in use :::8030', id: (first as { id?: number }).id });
    await node.untilStdout('error EADDRINUSE -98 listen :: 8030 listening=false\n');
    const second = await node.next('listen', (message) => message.type === 'listen' && message.port === 8031);
    node.receive({ type: 'listened', port: 8031, id: (second as { id?: number }).id });
    await node.untilStdout('listening on 8031\n');
    expect(node.stdout()).not.toContain('listening on 8030');
    // The refused registration is gone; the fallback serves.
    node.receive({ type: 'http-request', reqId: 1, port: 8030, request: { method: 'GET', url: '/', headers: {}, body: null } });
    expect(await node.next('response-head', (message) => message.type === 'response-head' && message.reqId === 1)).toMatchObject({ head: { status: 502 } });
    node.receive({ type: 'http-request', reqId: 2, port: 8031, request: { method: 'GET', url: '/', headers: {}, body: null } });
    expect(await node.next('response-head', (message) => message.type === 'response-head' && message.reqId === 2)).toMatchObject({ head: { status: 200 } });
    node.receive({ type: 'kill', signal: 'SIGKILL' });
  });

  it('a Python server exits with EADDRINUSE', { timeout: SLOW }, async () => {
    const python = driven((post) => createPythonWorkerProcess({ post, loadPyodide: ({ env }) => loadTestPyodide(env) }));
    python.receive(startMessage('gunicorn', ['-b', ':8031', 'wsgi:application'], { 'wsgi.py': WSGI_APP }));
    expect(await python.next('listen')).toMatchObject({ port: 8031 });
    python.receive({ type: 'listen-failed', port: 8031, message: 'listen EADDRINUSE' });
    expect(await python.next('exit')).toEqual({ type: 'exit', code: 1 });
    expect(python.posted.some((message) => message.type === 'stderr' && String(message.data).includes('address already in use'))).toBe(true);
  });
});

describe('frameworks from the network (extra coverage; skipped offline)', () => {
  it('FastAPI from requirements.txt, sync endpoints and run_sync inside them', { timeout: 300_000 }, async (context) => {
    if (!(await online())) return context.skip();
    const { ports, python } = pythonHost({
      'requirements.txt': 'fastapi\nuvicorn[standard]\n',
      'main.py': 'from fastapi import FastAPI\nfrom pyodide.ffi import can_run_sync\napp = FastAPI()\n@app.get("/items/{item_id}")\ndef read(item_id: int, q: str | None = None):\n    return {"item_id": item_id, "q": q, "blocking": can_run_sync()}\n',
    });
    const proc = python.run('uvicorn', ['main:app', '--port', '8010']);
    const log = collect(proc.combinedOutput);
    await serving(ports, 8010, proc, log);
    const response = await request(ports, 8010, 'GET', '/items/5?q=x');
    expect(response.status, log.text()).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ item_id: 5, q: 'x', blocking: true });
    proc.kill();
    await proc.wait();
    python.dispose();
  });

  it('Flask, a pure-Python wheel from PyPI', { timeout: 300_000 }, async (context) => {
    if (!(await online())) return context.skip();
    const { ports, python } = pythonHost({
      'requirements.txt': 'flask\n',
      'app.py': 'from flask import Flask, request\napp = Flask(__name__)\n@app.post("/echo")\ndef echo():\n    return {"got": request.get_json()["x"]}\n',
    });
    const proc = python.run('flask', ['run', '--port', '8011']);
    const log = collect(proc.combinedOutput);
    await serving(ports, 8011, proc, log);
    const response = await request(ports, 8011, 'POST', '/echo', '{"x": 7}', { 'content-type': 'application/json' });
    expect(response.status, log.text()).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ got: 7 });
    proc.kill();
    await proc.wait();
    python.dispose();
  });
});
