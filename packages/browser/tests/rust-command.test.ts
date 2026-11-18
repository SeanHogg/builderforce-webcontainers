/**
 * The Rust runtime's rules without a real module: command lines (prebuilt
 * modules, `wasmtime run`, the toolchain declined), the process-kind policy
 * and its relay Worker, the provider's declared profile and its declines, wasm
 * headers and imports, the service ABI's heads and limits, the bridge's
 * virtual TCP and flow control, and the one dial choke point.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, createChannelPair, readBody, type ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { WorkerToHost } from '../src/node/protocol.js';
import { createWorkerDialer } from '../src/node/workerConnections.js';
import { RELAY_RUST_WORKER, relayWorkerScript } from '../src/relayWorker.js';
import { createDotnetProcessKind } from '../src/runtimes/dotnet/index.js';
import { RUST_COMPILE_GATE, RUST_KIND, acceptsRustService, createRustProcessKind, isRustCommand, parseRustCommand } from '../src/runtimes/rust/index.js';
import { MAX_CONNECTIONS, MAX_RESPONSE_BYTES, REFUSED, RESET, WOULD_BLOCK, createRustBridge, decodeHeaders, encodeHead, type RustServiceExports } from '../src/runtimes/rust/rustBridge.js';
import { createRustDial } from '../src/runtimes/rust/rustDial.js';
import { missingImports, wasmHeader } from '../src/runtimes/rust/rustModule.js';
import { stubImports } from '../src/runtimes/rust/rustProgram.js';

const MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const COMPONENT = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A core module importing one `() -> ()` function: `module.name`. */
function importing(module: string, name: string): WebAssembly.Module {
  const text = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const imports = [1, ...text(module), ...text(name), 0x00, 0x00];
  return new WebAssembly.Module(new Uint8Array([...MODULE, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, imports.length, ...imports]));
}

describe('Rust commands', () => {
  it('takes prebuilt modules and wasmtime, and the toolchain to decline it', () => {
    for (const command of ['./target/wasm32-wasip1/release/api.wasm', 'app.wasm', 'wasmtime', 'cargo', 'rustc', 'rustup', 'cargo.exe']) expect(isRustCommand(command), command).toBe(true);
    for (const command of ['node', 'wasm', 'python', 'dotnet', 'app.wasm.js']) expect(isRustCommand(command), command).toBe(false);
  });

  it('runs a module by path with the whole environment and project', () => {
    expect(parseRustCommand('./api.wasm', ['--port', '1'])).toEqual({ ok: true, invocation: { module: './api.wasm', args: ['--port', '1'], env: {}, inherit: 'all' } });
  });

  it('parses wasmtime run as wasmtime does: --env K=V sets, --env K inherits, --dir HOST[::GUEST] preopens', () => {
    expect(parseRustCommand('wasmtime', ['run', '--env', 'A=1', '--env=B=2', '--env', 'HOME', '--dir', '.', '--dir=data::/d', 'app.wasm', 'x'])).toEqual({
      ok: true,
      invocation: { module: 'app.wasm', args: ['x'], env: { A: '1', B: '2' }, inherit: ['HOME'], dirs: [{ host: '.', guest: '.' }, { host: 'data', guest: '/d' }] },
    });
    expect(parseRustCommand('wasmtime', ['app.wasm'])).toEqual({ ok: true, invocation: { module: 'app.wasm', args: [], env: {}, inherit: [], dirs: [] } });
    expect(parseRustCommand('wasmtime', ['run', '--', 'app.wasm', '-v'])).toEqual({ ok: true, invocation: { module: 'app.wasm', args: ['-v'], env: {}, inherit: [], dirs: [] } });
  });

  it('declines cargo (the compile gate has not passed), wasmtime serve and unknown options, with reasons', () => {
    expect(RUST_COMPILE_GATE.passed).toBe(false);
    const cargo = parseRustCommand('cargo', ['run', '--release']);
    expect(!cargo.ok && cargo.reason).toMatch(/`cargo run --release` needs a Rust compiler.*rustc gate has not passed.*cargo build --release --target wasm32-wasip1/);
    expect(parseRustCommand('rustc', ['main.rs']).ok).toBe(false);
    const serve = parseRustCommand('wasmtime', ['serve', 'app.wasm']);
    expect(!serve.ok && serve.reason).toMatch(/preview 2/);
    const option = parseRustCommand('wasmtime', ['run', '--invoke', 'f', 'app.wasm']);
    expect(!option.ok && option.reason).toMatch(/--invoke is not supported/);
    expect(parseRustCommand('wasmtime', ['run']).ok).toBe(false);
    expect(parseRustCommand('wasmtime', ['run', '--env']).ok).toBe(false);
  });
});

describe('Rust process kind', () => {
  it('routes Rust commands to the rust Worker, chained before .NET and Node, and merges foreign commands', () => {
    const fs = new VirtualFileSystem();
    const kinds = createRustProcessKind(createDotnetProcessKind({ bundleUrl: 'https://x.test/' }));
    const context = { fs, cwd: '/', env: {} };
    expect(kinds.route('./target/wasm32-wasip1/release/api.wasm', [], context)).toEqual({ kind: RUST_KIND, command: './target/wasm32-wasip1/release/api.wasm', args: [] });
    expect(kinds.route('cargo', ['run'], context).kind).toBe(RUST_KIND);
    expect(kinds.route('dotnet', ['run'], context).kind).toBe('dotnet');
    expect(kinds.route('node', ['x.js'], context).kind).toBe('node');
    expect(kinds.startOptions(RUST_KIND)).toEqual({});
    expect(kinds.startOptions('dotnet')).toEqual({ dotnet: { bundleUrl: 'https://x.test/' } });
    const foreign = new RegExp(kinds.foreignCommands!);
    for (const name of ['cargo', 'api.wasm', 'wasmtime', 'dotnet']) expect(foreign.test(name), name).toBe(true);
    expect(foreign.test('node')).toBe(false);
    expect(kinds.receive(RUST_KIND, { type: 'php-platform' })).toBe(false);
  });

  it('the relay starts rust-worker.js for a rust Worker', () => {
    expect(relayWorkerScript('rust')).toEqual({ file: RELAY_RUST_WORKER, name: 'bfwc-rust' });
    expect(RELAY_RUST_WORKER).toBe('rust-worker.js');
  });

  it('a dial carries no identity: attribution is the page side’s, by the Worker it arrives on', () => {
    const posted: WorkerToHost[] = [];
    const dialer = createWorkerDialer((message) => posted.push(message));
    void createRustDial((port) => dialer.dial(port))(5432);
    expect(posted).toEqual([{ type: 'dial', connId: 1, port: 5432 }]);
    expect(Object.keys(posted[0]!).sort()).toEqual(['connId', 'port', 'type']);
  });
});

describe('rust provider', () => {
  const service = (overrides: Partial<ServiceSpec>): ServiceSpec => ({ id: 'api', type: 'application', runtime: 'rust', command: './target/wasm32-wasip1/release/api.wasm', root: '/api', port: 8080, ...overrides }) as ServiceSpec;

  it('accepts a prebuilt module and declines what is outside its profile, with the reason', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/api/target/wasm32-wasip1/release/api.wasm', MODULE);
    fs.writeFile('/api/p2.wasm', COMPONENT);
    fs.writeFile('/api/text.wasm', 'not wasm');
    expect(acceptsRustService(service({}), fs)).toEqual({ ok: true });
    expect(acceptsRustService(service({ command: 'wasmtime', args: ['run', 'target/wasm32-wasip1/release/api.wasm'] }), fs)).toEqual({ ok: true });
    const reason = (spec: ServiceSpec) => {
      const result = acceptsRustService(spec, fs);
      return result.ok ? 'accepted' : result.reason;
    };
    expect(reason(service({ command: 'cargo', args: ['run'] }))).toMatch(/rustc gate has not passed/);
    expect(reason(service({ command: 'node' }))).toMatch(/not a Rust runtime command.*prebuilt wasm32-wasip1 modules/);
    expect(reason(service({ command: './missing.wasm' }))).toMatch(/\/api\/missing.wasm does not exist.*cargo build --release --target wasm32-wasip1/);
    expect(reason(service({ command: './p2.wasm' }))).toMatch(/component \(WASI preview 2/);
    expect(reason(service({ command: './text.wasm' }))).toMatch(/not a WebAssembly module/);
    expect(reason(service({ type: 'database' }))).toMatch(/runs application services/);
    expect(reason(service({ readiness: { kind: 'query' } }))).toMatch(/"query" readiness/);
    expect(acceptsRustService(service({ command: './missing.wasm' }))).toEqual({ ok: true }); // without files, only the command is checked
  });

  it('tells modules from components', () => {
    expect(wasmHeader(MODULE)).toBe('module');
    expect(wasmHeader(COMPONENT)).toBe('component');
    expect(wasmHeader(new Uint8Array([1, 2, 3]))).toBe('not-wasm');
  });
});

describe('Rust module imports', () => {
  it('stubs an import from `__proto__` without touching any prototype', async () => {
    const module = importing('__proto__', 'polluted');
    const stubs = stubImports(module);
    expect(Object.getPrototypeOf(stubs)).toBeNull();
    expect(Object.hasOwn(stubs, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const instance = await WebAssembly.instantiate(module, { ...stubs });
    expect(instance).toBeDefined();
  });

  it('names a bfwc or WASI function the runtime lacks, so the module is declined before it links', () => {
    expect(missingImports(importing('bfwc', 'teleport'), { bfwc: { listen: () => 0 }, wasi_snapshot_preview1: {} })).toEqual(['bfwc.teleport']);
    expect(missingImports(importing('wasi_snapshot_preview1', 'fd_magic'), { bfwc: {}, wasi_snapshot_preview1: { fd_write: () => 0 } })).toEqual(['wasi_snapshot_preview1.fd_magic']);
    expect(missingImports(importing('bfwc', 'listen'), { bfwc: { listen: () => 0 }, wasi_snapshot_preview1: {} })).toEqual([]);
    expect(missingImports(importing('wasi:cli/environment@0.2.12', 'get-environment'), { bfwc: {}, wasi_snapshot_preview1: {} })).toEqual([]); // stubbed instead
  });
});

describe('Rust service ABI (host side)', () => {
  it('encodes request heads without line breaks and decodes response headers', () => {
    expect(new TextDecoder().decode(encodeHead('GET', '/a?b=1', { host: 'x', evil: 'a\r\nb' }))).toBe('GET /a?b=1\nhost:x\nevil:a b');
    expect(decodeHeaders('Content-Type:application/json\nset-cookie:a=1\nset-cookie:b=2')).toEqual({ 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
  });

  it('header names like constructor and __proto__ are plain headers; non-token names are dropped', () => {
    const headers = decodeHeaders('constructor:x\n__proto__:y\ntoString:z\nbad name:w\n(x):v');
    expect(Object.keys(headers).sort()).toEqual(['__proto__', 'constructor', 'tostring']);
    expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe('y');
    expect(headers.constructor).toBe('x');
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    const cloned = structuredClone(headers);
    expect(Object.getOwnPropertyDescriptor(cloned, '__proto__')?.value).toBe('y');
    expect(cloned.constructor).toBe('x');
  });

  /** A stand-in module: memory plus the exports the bridge calls, with a poll the test drives. */
  function fakeService(onRequest: (reqId: number, head: string, body: string) => void, onPoll: () => number = () => 0) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    let top = 1024;
    const view = () => new Uint8Array(memory.buffer);
    const exports: RustServiceExports = {
      memory,
      bfwc_abi_version: () => 1,
      bfwc_start: () => 0,
      bfwc_alloc: (length) => {
        const at = top;
        top += length + 8;
        return at;
      },
      bfwc_request: (reqId, head, headLength, body, bodyLength) => onRequest(reqId, new TextDecoder().decode(view().slice(head, head + headLength)), new TextDecoder().decode(view().slice(body, body + bodyLength))),
      bfwc_poll: () => onPoll(),
    };
    const write = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      const at = exports.bfwc_alloc(bytes.length);
      view().set(bytes, at);
      return [at, bytes.length] as const;
    };
    return { exports, write, view };
  }

  /** A bridge whose service answers every request with `answer(reqId)`. */
  function answering(answer: (bridge: ReturnType<typeof createRustBridge>, service: ReturnType<typeof fakeService>, reqId: number) => void) {
    const faults: unknown[] = [];
    let bridge!: ReturnType<typeof createRustBridge>;
    const service = fakeService((reqId) => answer(bridge, service, reqId));
    bridge = createRustBridge({ dial: async () => undefined, onFault: (error) => faults.push(error) });
    bridge.attach(service.exports);
    const get = () => bridge.handle({ method: 'GET', url: '/', headers: {}, body: null });
    return { bridge, service, faults, get };
  }

  it('answers a request through respond, after a poll', async () => {
    let bridge!: ReturnType<typeof createRustBridge>;
    let polls = 0;
    const service = fakeService(
      (reqId, head, body) => {
        expect(head).toBe('POST /todos\ncontent-type:application/json');
        expect(body).toBe('{"title":"x"}');
        const [headAt, headLength] = service.write('content-type:application/json');
        const [bodyAt, bodyLength] = service.write('{"id":1}');
        bridge.imports.respond!(reqId, 201, headAt, headLength, bodyAt, bodyLength);
      },
      () => (polls++, 0),
    );
    bridge = createRustBridge({ dial: async () => undefined, onFault: (error) => expect.fail(String(error)) });
    expect(bridge.imports.listen!(8080)).toBe(0);
    expect(bridge.imports.listen!(9090)).toBe(-1); // one port per process
    bridge.attach(service.exports);
    const response = await bridge.handle({ method: 'POST', url: '/todos', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"title":"x"}') });
    expect(response.status).toBe(201);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(new TextDecoder().decode(await readBody(response.body))).toBe('{"id":1}');
    await Promise.resolve();
    expect(polls).toBe(1);
  });

  it('a response with a `constructor` header resolves, and its head structured-clones', async () => {
    const { get } = answering((bridge, service, reqId) => {
      const [headAt, headLength] = service.write('constructor:x\n__proto__:y');
      bridge.imports.respond!(reqId, 200, headAt, headLength, 0, 0);
    });
    const response = await get();
    expect(structuredClone({ status: response.status, headers: response.headers })).toEqual({ status: 200, headers: response.headers });
  });

  it('respond with an out-of-bounds pointer fails that request and traps the module, never hangs', async () => {
    const { get, faults } = answering((bridge, _service, reqId) => bridge.imports.respond!(reqId, 200, 0xffff_fff0, 64, 0, 0));
    await expect(get()).rejects.toThrow(/out of bounds/);
    expect(faults).toHaveLength(1);
  });

  it('a status outside 200–599 or a body over the cap answers 502', async () => {
    for (const status of [99, 101, 600, -1]) {
      const { get } = answering((bridge, _service, reqId) => bridge.imports.respond!(reqId, status, 0, 0, 0, 0));
      const response = await get();
      expect(response.status, String(status)).toBe(502);
      expect(new TextDecoder().decode(await readBody(response.body))).toMatch(/invalid status/);
    }
    const { get } = answering((bridge, _service, reqId) => bridge.imports.respond!(reqId, 200, 0, 0, 0, MAX_RESPONSE_BYTES + 1));
    expect((await get()).status).toBe(502);
  });

  it('a trap while polling ends the process and fails pending requests', async () => {
    const faults: unknown[] = [];
    const service = fakeService(() => undefined, () => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    const bridge = createRustBridge({ dial: async () => undefined, onFault: (error) => faults.push(error) });
    bridge.attach(service.exports);
    await expect(bridge.handle({ method: 'GET', url: '/', headers: {}, body: null })).rejects.toThrow(/exited/);
    expect(faults).toHaveLength(1);
  });

  it('a service whose tasks keep waking themselves stops being polled once killed', async () => {
    let polls = 0;
    const service = fakeService(() => undefined, () => (polls++, 1));
    const bridge = createRustBridge({ dial: async () => undefined, onFault: (error) => expect.fail(String(error)) });
    bridge.attach(service.exports);
    bridge.schedule();
    for (let i = 0; i < 5; i++) await tick();
    expect(polls).toBeGreaterThan(1); // each pass yields to the event loop, so a kill gets through
    bridge.close();
    const stopped = polls;
    for (let i = 0; i < 5; i++) await tick();
    expect(polls).toBe(stopped);
    await expect(bridge.handle({ method: 'GET', url: '/', headers: {}, body: null })).rejects.toThrow(/not running/);
  });

  it('listen takes ports 1–65535, only during bfwc_start', () => {
    const bridge = createRustBridge({ dial: async () => undefined, onFault: () => undefined });
    for (const port of [0, -1, 65536, 1.5]) expect(bridge.imports.listen!(port), String(port)).toBe(-1);
    bridge.started();
    expect(bridge.imports.listen!(8080)).toBe(-1);
    expect(bridge.port).toBeUndefined();
  });

  it('dials virtual TCP: held writes, would-block reads, data, EOF and refusal', async () => {
    let server!: ByteChannel;
    const received: string[] = [];
    const bridge = createRustBridge({
      dial: async (port) => {
        if (port !== 5432) return undefined;
        const [client, far] = createChannelPair();
        server = far;
        server.onData((data) => received.push(new TextDecoder().decode(data)));
        return client;
      },
      onFault: (error) => expect.fail(String(error)),
    });
    const service = fakeService(() => undefined);
    bridge.attach(service.exports);
    const { imports } = bridge;
    const handle = imports.connect!(5432) as number;
    const [at, length] = service.write('startup');
    expect(imports.send!(handle, at, length)).toBe(length); // held until the dial resolves
    expect(imports.recv!(handle, 2048, 64)).toBe(WOULD_BLOCK);
    await tick();
    expect(received.join('')).toBe('startup');
    server.send(new TextEncoder().encode('R-ok'));
    await tick();
    expect(imports.recv!(handle, 2048, 2)).toBe(2);
    expect(imports.recv!(handle, 2050, 64)).toBe(2);
    expect(new TextDecoder().decode(service.view().slice(2048, 2052))).toBe('R-ok');
    server.close();
    await tick();
    expect(imports.recv!(handle, 2048, 64)).toBe(0); // end of file
    imports.close!(handle);
    expect(imports.recv!(handle, 2048, 64)).toBe(RESET);

    const refused = imports.connect!(1) as number;
    await tick();
    expect(imports.recv!(refused, 2048, 64)).toBe(REFUSED);
    expect(imports.send!(refused, at, length)).toBe(REFUSED);
  });

  it('refuses bad ports and connections past the cap', () => {
    const bridge = createRustBridge({ dial: () => new Promise(() => undefined), onFault: () => undefined });
    bridge.attach(fakeService(() => undefined).exports);
    for (const port of [0, 65536, -5]) expect(bridge.imports.connect!(port), String(port)).toBe(REFUSED);
    for (let i = 0; i < MAX_CONNECTIONS; i++) expect(bridge.imports.connect!(5432)).toBeGreaterThan(0);
    expect(bridge.imports.connect!(5432)).toBe(REFUSED);
  });

  it('writes would block above the high-water mark until the reader catches up', async () => {
    const bridge = createRustBridge({ dial: async () => createChannelPair()[0], onFault: (error) => expect.fail(String(error)), highWaterMark: 4 });
    const service = fakeService(() => undefined);
    bridge.attach(service.exports);
    const { imports } = bridge;
    const handle = imports.connect!(5432) as number;
    const [at, length] = service.write('12345678');
    expect(imports.send!(handle, at, length)).toBe(8); // held while dialling
    expect(imports.send!(handle, at, length)).toBe(WOULD_BLOCK); // held bytes over the mark
    await tick();
    expect(imports.send!(handle, at, length)).toBe(8);
    expect(imports.send!(handle, at, length)).toBe(WOULD_BLOCK); // in flight, unread
    await tick(); // the far end reads (credits at once): room again
    expect(imports.send!(handle, at, length)).toBe(8);
  });
});
