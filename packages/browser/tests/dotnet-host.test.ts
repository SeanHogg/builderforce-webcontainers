/**
 * The .NET runtime's process side on a fake runtime (the real one needs the
 * bundle: dotnet-integration.test.ts): a real ProcessHost routes `dotnet` to
 * a .NET Worker, whose worker code plans, "loads" the runtime with the right
 * environment, mirrors the build's output to the page, serves the in-memory
 * server's port through the process protocol, dials virtual TCP, ends on a
 * kill, and refuses what it cannot build before loading anything. Also the
 * chained process-kind policy and the start options, the relay's .NET Worker
 * kind, and the Worker supply's .NET spawns (always cold).
 */
import { describe, expect, it } from 'vitest';
import { VfsSnapshots, VirtualFileSystem, WORKSPACE_CONTEXT } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerLike } from '../src/node/processHost.js';
import { NODE_ONLY } from '../src/node/processKinds.js';
import type { WorkerKind } from '../src/node/protocol.js';
import { WorkerSupply } from '../src/node/workerSupply.js';
import { RELAY_SPAWN } from '../src/protocol.js';
import { RELAY_DOTNET_WORKER, relayWorkerScript, spawnOverRelay } from '../src/relayWorker.js';
import { DOTNET_KIND, createDotnetProcessKind, type DotnetLoadOptions, type LoadedDotnet } from '../src/runtimes/dotnet/index.js';
import type { WrappableEmscriptenFs } from '../src/runtimes/emscripten/wrappedFsWrites.js';
import { createPhpProcessKind } from '../src/runtimes/php/index.js';
import { dotnetHost } from './dotnet-helpers.js';
import { readAll, request, until } from './php-helpers.js';

/** An in-memory Emscripten-shaped FS whose writeFile goes through open/write/close, as Emscripten's does (so the mirror hears it). */
function fakeFs(): WrappableEmscriptenFs {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/']);
  const fs = {
    mkdirTree(path: string) {
      let at = '';
      for (const part of path.split('/').filter(Boolean)) dirs.add((at += `/${part}`));
    },
    mkdir(path: string) {
      dirs.add(path);
    },
    open(path: string) {
      return { path };
    },
    write(stream: { path?: string }, data: Uint8Array) {
      files.set(stream.path!, data);
      return data.length;
    },
    close(_stream: unknown) {},
    writeFile(path: string, data: string | Uint8Array) {
      const stream = fs.open(path);
      fs.write(stream, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      fs.close(stream);
    },
    readFile: (path: string) => files.get(path)!,
    readdir: (path: string) => [...files.keys(), ...dirs].filter((entry) => entry !== path && entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map((entry) => entry.slice(path.length + 1)),
    stat: (path: string) => ({ mode: dirs.has(path) ? 1 : 0 }),
    isDir: (mode: number) => mode === 1,
    unlink: (path: string) => void files.delete(path),
    rmdir: (path: string) => void dirs.delete(path),
    rename() {},
    symlink() {},
    analyzePath: (path: string) => ({ exists: files.has(path) || dirs.has(path) }),
    cwd: () => '/project',
    truncate() {},
    ftruncate() {},
    getStream: () => undefined,
  };
  return fs as unknown as WrappableEmscriptenFs;
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** A fake runtime: Build writes the "assembly" (Program.cs's text), Run acts on it — print, serve, or dial. */
function fakeRuntime(seen: { env?: Record<string, string>; loads: number }) {
  return async (options: DotnetLoadOptions): Promise<LoadedDotnet> => {
    seen.loads++;
    seen.env = options.env;
    const FS = fakeFs();
    const { imports } = options;
    let stopServer: ((code: number) => void) | undefined;
    return {
      FS,
      manifest: { references: { netcore: { pack: '', files: [] }, aspnetcore: { pack: '', files: [] } }, packages: {} } as never,
      mountReferences: async () => new Map(),
      exports: {
        Init() {},
        Flush() {},
        async Build(planJson) {
          const plan = JSON.parse(planJson) as { sources: string[]; outputPath: string; quiet: boolean };
          const source = plan.sources.map((path) => text(FS.readFile(path))).join('\n');
          if (source.includes('ERROR')) {
            imports.stdout('Program.cs(1,1): error CS0103: The name \'ERROR\' does not exist in the current context [api.csproj]\n');
            return 1;
          }
          FS.mkdirTree(plan.outputPath.slice(0, plan.outputPath.lastIndexOf('/')));
          FS.writeFile(plan.outputPath, source);
          if (!plan.quiet) imports.stdout('Build succeeded.\n');
          return 0;
        },
        async Run(path, args) {
          const program = text(FS.readFile(path));
          if (program.startsWith('console:')) {
            imports.stdout(`${program.slice(8).trim()} ${args.join(' ')}\n`);
            return 3;
          }
          if (program.startsWith('serve:')) {
            const port = Number(program.slice(6));
            if (!imports.listen(port)) {
              imports.stderr('address already in use\n');
              return 1;
            }
            imports.stdout(`Now listening on: http://localhost:${port}\n`);
            return new Promise<number>((resolve) => (stopServer = resolve));
          }
          if (program.startsWith('dial:')) {
            const connId = await imports.dial(Number(program.slice(5)));
            imports.stdout(`dialled ${connId}\n`);
            return connId < 0 ? 1 : 0;
          }
          return 0;
        },
        Request(reqId, _port, method, url, headersJson, body) {
          imports.respondHead(reqId, 201, JSON.stringify({ 'Content-Type': ['text/plain'], 'Set-Cookie': ['a=1', 'b=2'] }));
          imports.respondChunk(reqId, new TextEncoder().encode(`${method} ${url} `));
          imports.respondChunk(reqId, new TextEncoder().encode(`${JSON.parse(headersJson)['x-test']} ${text(body)}`));
          imports.respondEnd(reqId, null);
        },
        CancelRequest() {},
        Stop() {
          stopServer?.(0);
        },
        TcpData() {},
        TcpClosed() {},
      },
    };
  };
}

const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';

describe('.NET processes (fake runtime)', () => {
  it('builds, mirrors the assembly to the page, and runs with the launch profile and arguments', async () => {
    const seen = { loads: 0 } as { env?: Record<string, string>; loads: number };
    const launch = JSON.stringify({ profiles: { http: { commandName: 'Project', applicationUrl: 'http://localhost:5100', environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' } } } });
    const { fs, processes } = dotnetHost({ 'api/api.csproj': CSPROJ, 'api/Program.cs': 'console: hello', 'api/Properties/launchSettings.json': launch }, fakeRuntime(seen));
    const proc = processes.run('dotnet', ['run', '--', 'x', 'y'], { cwd: '/api' });
    expect(await readAll(proc.combinedOutput)).toBe('hello x y\n');
    expect(await proc.wait()).toBe(3);
    expect(seen.env).toMatchObject({ ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: 'http://localhost:5100', DOTNET_NOLOGO: '1' });
    await until(() => fs.readText('/api/bin/Debug/net10.0/api.dll') !== undefined);
    expect(fs.readText('/api/bin/Debug/net10.0/api.dll')).toBe('console: hello');
    processes.dispose();
  });

  it('reports build errors and refuses unbuildable projects before loading the runtime', async () => {
    const seen = { loads: 0 };
    const { processes } = dotnetHost({ 'api/api.csproj': CSPROJ, 'api/Program.cs': 'ERROR', 'bad/bad.csproj': CSPROJ.replace('</Project>', '<ItemGroup><PackageReference Include="Dapper" /></ItemGroup></Project>'), 'bad/a.cs': '' }, fakeRuntime(seen));
    const failed = processes.run('dotnet', ['run'], { cwd: '/api' });
    const output = await readAll(failed.combinedOutput);
    expect(output).toContain('error CS0103');
    expect(output).toContain('The build failed. Fix the build errors and run again.');
    expect(await failed.wait()).toBe(1);
    const refused = processes.run('dotnet', ['build'], { cwd: '/bad' });
    expect(await readAll(refused.combinedOutput)).toContain('does not carry: Dapper');
    expect(await refused.wait()).toBe(1);
    const declined = processes.run('dotnet', ['watch']);
    expect(await readAll(declined.combinedOutput)).toContain('dotnet watch');
    expect(await declined.wait()).toBe(1);
    expect(seen.loads).toBe(1);
    processes.dispose();
  });

  it('serves the in-memory server through the process protocol, and stops on a kill', async () => {
    const { processes } = dotnetHost({ 'api/api.csproj': CSPROJ, 'api/Program.cs': 'serve:8081' }, fakeRuntime({ loads: 0 }));
    const proc = processes.run('dotnet', ['run'], { cwd: '/api' });
    await until(() => processes.ports.has(8081));
    const response = await request(processes.ports, 8081, 'POST', '/items?x=1', 'body!', { 'x-test': 'yes' });
    expect(response.status).toBe(201);
    expect(response.text).toBe('POST /items?x=1 yes body!');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    proc.kill('SIGTERM');
    expect(await proc.wait()).toBe(143);
    await until(() => !processes.ports.has(8081));
    processes.dispose();
  });

  it('dials virtual ports: refused where nothing listens', async () => {
    const { processes } = dotnetHost({ 'tool/tool.csproj': CSPROJ, 'tool/Program.cs': 'dial:6553' }, fakeRuntime({ loads: 0 }));
    const proc = processes.run('dotnet', ['run'], { cwd: '/tool' });
    expect(await readAll(proc.combinedOutput)).toBe('dialled -1\n');
    expect(await proc.wait()).toBe(1);
    processes.dispose();
  });

  it('says so when the host gave no runtime bundle', async () => {
    const { processes } = dotnetHost({ 'api/api.csproj': CSPROJ, 'api/Program.cs': 'console:' }, fakeRuntime({ loads: 0 }), {});
    const proc = processes.run('dotnet', ['run'], { cwd: '/api' });
    expect(await readAll(proc.combinedOutput)).toContain('dotnet.bundleUrl');
    expect(await proc.wait()).toBe(1);
    processes.dispose();
  });
});

describe('.NET Worker kind', () => {
  it('routes dotnet and dotnet shebangs, chains to PHP then Node, and carries the bundle URL', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'app.cs': '#!/usr/bin/env dotnet\nConsole.WriteLine(1);\n', 'run.php': '#!/usr/bin/env php\n<?php echo 1;' });
    const kinds = createDotnetProcessKind({ bundleUrl: 'https://cdn.test/dotnet/' }, createPhpProcessKind({}, NODE_ONLY));
    const context = { fs, cwd: '/', env: { PATH: '/usr/bin' } };
    expect(kinds.route('dotnet', ['run'], context)).toEqual({ kind: DOTNET_KIND, command: 'dotnet', args: ['run'] });
    expect(kinds.route('./app.cs', ['a'], context)).toEqual({ kind: DOTNET_KIND, command: 'dotnet', args: ['/app.cs', 'a'] });
    expect(kinds.route('php', ['-v'], context).kind).toBe('php');
    expect(kinds.route('node', [], context).kind).toBe('node');
    expect(kinds.startOptions(DOTNET_KIND, WORKSPACE_CONTEXT)).toEqual({ dotnet: { bundleUrl: 'https://cdn.test/dotnet/' } });
    expect(kinds.startOptions('php', WORKSPACE_CONTEXT)).toHaveProperty('php');
    expect(new RegExp(kinds.foreignCommands!).test('dotnet')).toBe(true);
    expect(new RegExp(kinds.foreignCommands!).test('php')).toBe(true);
    expect(kinds.receive(DOTNET_KIND, { type: 'python-installed' }, WORKSPACE_CONTEXT)).toBe(false);
  });

  it('the relay is asked for a dotnet Worker, and starts dotnet-worker.js', () => {
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const worker = spawnOverRelay((message, transfer) => posted.push({ message, transfer }), DOTNET_KIND);
    expect(posted[0]!.message).toEqual({ type: RELAY_SPAWN, worker: 'dotnet' });
    worker.terminate();
    expect(relayWorkerScript('dotnet')).toEqual({ file: RELAY_DOTNET_WORKER, name: 'bfwc-dotnet' });
    expect(RELAY_DOTNET_WORKER).toBe('dotnet-worker.js');
    expect(relayWorkerScript('toString')).toEqual(relayWorkerScript('node'));
  });

  it('a .NET spawn is cold and never takes the primed Node spare', async () => {
    const created: WorkerKind[] = [];
    const worker = (kind: WorkerKind): WorkerLike => {
      created.push(kind);
      const made: WorkerLike = {
        onmessage: null,
        postMessage: (message) => (message as { type?: string }).type === 'prime' && queueMicrotask(() => made.onmessage?.({ data: { type: 'primed' } })),
        terminate: () => undefined,
      };
      return made;
    };
    const supply = new WorkerSupply(worker, new VfsSnapshots(new VirtualFileSystem()), true);
    supply.take('node'); // schedules a spare
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dotnet = supply.take(DOTNET_KIND);
    expect(dotnet.snapshot.pack).toBeDefined(); // cold: the whole snapshot
    expect(created).toEqual(['node', 'node', 'dotnet']);
    expect(supply.warmStarts).toBe(0);
    supply.dispose();
  });
});
