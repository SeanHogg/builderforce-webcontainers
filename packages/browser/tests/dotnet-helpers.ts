/**
 * .NET processes driven in-thread: the real worker code
 * (createDotnetWorkerProcess) behind a real ProcessHost that also runs Node
 * processes — only the Worker boundary is faked. The runtime is either a fake
 * (`fakeDotnet`, for the protocol) or the real bundle built by
 * scripts/build-dotnet-runtime.mjs (`DOTNET_BUNDLE_DIR`, when it exists),
 * loaded from disk. Mono's runtime is a singleton of its realm: a test file
 * starts at most one real .NET process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import { DOTNET_KIND, createDotnetProcessKind, createDotnetWorkerProcess, loadDotnetRuntime, type DotnetDial as Dial, type DotnetHostOptions, type DotnetLoadOptions, type LoadedDotnet } from '../src/runtimes/dotnet/index.js';
import { fakeWorker } from './helpers.js';

/**
 * The bundle: `BFWC_DOTNET_BUNDLE`, else dotnet-host/out — undefined until it has been built. A bundle named
 * by `BFWC_DOTNET_BUNDLE` must exist: CI sets it, and its real-runtime tests must fail, never skip, without one.
 */
const configured = process.env.BFWC_DOTNET_BUNDLE ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dotnet-host', 'out');
const built = existsSync(join(configured, 'manifest.json'));
if (process.env.BFWC_DOTNET_BUNDLE && !built) throw new Error(`BFWC_DOTNET_BUNDLE is ${process.env.BFWC_DOTNET_BUNDLE}, but it has no manifest.json: build the bundle (scripts/build-dotnet-runtime.mjs) or unset it.`);
export const DOTNET_BUNDLE_DIR = built ? configured : undefined;
export const DOTNET_BUNDLE_URL = DOTNET_BUNDLE_DIR ? pathToFileURL(`${DOTNET_BUNDLE_DIR}/`).href : 'https://bundle.test/dotnet/';

/** `fetch` for file: URLs (the bundle on disk), as a static server would answer. */
export const fileFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = fileURLToPath(url);
  if (!existsSync(path)) return new Response('not found', { status: 404 });
  return new Response(readFileSync(path));
};

/** The real runtime from the bundle on disk. */
export const loadBundledDotnet = (options: DotnetLoadOptions) => loadDotnetRuntime({ ...options, fetch: fileFetch });

/** A .NET process Worker running in this thread, with structured-clone messaging like the real thing. `dial` replaces the process protocol's dialled connections. */
export function fakeDotnetWorker(loadDotnet: (options: DotnetLoadOptions) => Promise<LoadedDotnet>, dial?: Dial): WorkerLike {
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
  const proc = createDotnetWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    loadDotnet,
    dial,
    fetch: fileFetch,
  });
  return worker;
}

/** In-thread Workers of each kind: .NET processes on `loadDotnet`, the rest on the Node runtime. */
export const dotnetWorkers = (loadDotnet: (options: DotnetLoadOptions) => Promise<LoadedDotnet>, dial?: Dial) => (kind: WorkerKind) => (kind === DOTNET_KIND ? fakeDotnetWorker(loadDotnet, dial) : fakeWorker());

/** A process host whose `dotnet` commands run in .NET Workers. */
export function dotnetHost(files: Record<string, string>, loadDotnet: (options: DotnetLoadOptions) => Promise<LoadedDotnet>, options: DotnetHostOptions = { bundleUrl: DOTNET_BUNDLE_URL }, dial?: Dial) {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  const processes = new ProcessHost({
    fs,
    createWorker: dotnetWorkers(loadDotnet, dial),
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    killGraceMs: 500,
    packageCache: false,
    kinds: createDotnetProcessKind(options),
  });
  return { fs, ports: processes.ports, processes };
}
