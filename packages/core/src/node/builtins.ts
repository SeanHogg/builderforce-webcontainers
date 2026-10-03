/**
 * The builtin module table for one runtime. Modules are built lazily on first
 * `require` (most programs touch a handful) and are per-process, because `fs`,
 * `path` and `process` close over that process's cwd, IO and event loop.
 */
import type { VirtualFileSystem } from '../vfs.js';
import type { ProgramIO, System } from '../system/types.js';
import type { EventLoop } from './loop.js';
import type { NodeProcess } from './process.js';
import { createEventsModule } from './events.js';
import { createBufferModule } from './buffer.js';
import { createPathModule } from './path.js';
import { createUtilModule, types as utilTypes } from './util.js';
import { createStreamModule } from './stream/index.js';
import { createFsModule } from './fs/index.js';
import { constants as fsConstants } from './fs/stats.js';
import { createCryptoModule } from './crypto.js';
import { createQuerystringModule, createUrlModule } from './urlqs.js';
import { createAssertModule } from './assert.js';
import { createZlibModule } from './zlib.js';
import { createHttpModule, createNetModule, createFetch } from './http/index.js';
import { createChildProcessModule } from './childProcess.js';
import { createReadlineModule } from './readline.js';
import { createAsyncHooksModule, createDiagnosticsChannelModule, createOsModule, createStringDecoderModule, createStubModules, createTimersModule, createTtyModule, createVmModule } from './misc.js';


export interface BuiltinDeps {
  fs: VirtualFileSystem;
  process: NodeProcess;
  loop: EventLoop;
  system: System;
  io: ProgramIO;
  console: Console;
}

type Factory = (get: (name: string) => any) => unknown;

export function createBuiltins(deps: BuiltinDeps) {
  const { process: proc, loop, system } = deps;
  const env = () => proc.env as Record<string, string | undefined>;
  const stubs = createStubModules();
  const clientDeps = { system, loop };

  const factories: Record<string, Factory> = {
    assert: () => createAssertModule(false),
    'assert/strict': () => createAssertModule(true),
    async_hooks: () => createAsyncHooksModule(),
    buffer: () => createBufferModule(),
    child_process: () =>
      createChildProcessModule({
        system,
        loop,
        cwd: () => proc.cwd(),
        env,
        stdout: (c) => proc.stdout.write(c),
        stderr: (c) => proc.stderr.write(c),
      }),
    console: () => Object.assign(Object.create(deps.console), { Console: function Console() { return deps.console; } }),
    constants: (get) => ({ ...fsConstants, ...(get('os').constants.signals as object) }),
    crypto: () => createCryptoModule(),
    diagnostics_channel: () => createDiagnosticsChannelModule(),
    'dns/promises': (get) => get('dns').promises,
    events: () => createEventsModule(),
    fs: () => createFsModule({ vfs: deps.fs, cwd: () => proc.cwd(), stdout: deps.io.stdout, stderr: deps.io.stderr, hold: () => loop.hold() }),
    'fs/promises': (get) => get('fs').promises,
    http: () => createHttpModule(clientDeps, 'http:'),
    https: () => createHttpModule(clientDeps, 'https:'),
    net: () => createNetModule(clientDeps),
    os: () => createOsModule(env),
    path: () => createPathModule(() => proc.cwd()),
    'path/posix': (get) => get('path'),
    'path/win32': (get) => get('path'),
    process: () => proc,
    querystring: () => createQuerystringModule(),
    readline: () => createReadlineModule(),
    'readline/promises': (get) => get('readline').promises,
    stream: () => createStreamModule(),
    'stream/promises': (get) => get('stream').promises,
    'stream/web': () => ({ ReadableStream, WritableStream, TransformStream, TextEncoderStream, TextDecoderStream, ByteLengthQueuingStrategy, CountQueuingStrategy }),
    'stream/consumers': () => ({
      text: async (stream: AsyncIterable<unknown>) => {
        let out = '';
        for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
        return out;
      },
      json: async (stream: AsyncIterable<unknown>) => {
        let out = '';
        for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
        return JSON.parse(out);
      },
    }),
    string_decoder: () => createStringDecoderModule(),
    sys: (get) => get('util'),
    timers: () => createTimersModule(loop),
    'timers/promises': (get) => get('timers').promises,
    tty: () => createTtyModule(!!deps.io.terminal),
    url: (get) => createUrlModule(get('querystring')),
    util: () => createUtilModule(env, (message) => proc.stderr.write(message + '\n')),
    'util/types': () => utilTypes,
    vm: () => createVmModule(),
    zlib: () => createZlibModule(),
  };
  for (const [name, mod] of Object.entries(stubs)) factories[name] ??= () => mod;

  const cache = new Map<string, unknown>();
  const get = (name: string): any => {
    if (cache.has(name)) return cache.get(name);
    const factory = factories[name];
    if (!factory) throw Object.assign(new Error(`No such built-in module: ${name}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    const mod = factory(get);
    cache.set(name, mod);
    return mod;
  };

  return {
    names: [...Object.keys(factories), 'module'].sort(),
    isBuiltin: (name: string) => name === 'module' || name in factories,
    get,
    fetch: createFetch(clientDeps),
  };
}

export type Builtins = ReturnType<typeof createBuiltins>;
