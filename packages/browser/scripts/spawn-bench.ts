/**
 * Process spawn cost vs project size (PRD 31 §W9 phases 0–1). Prints, never
 * asserts — a script, not a test (it sits outside the vitest glob).
 *
 *   cd packages/browser && node <vite-node>/vite-node.mjs scripts/spawn-bench.ts
 *
 * It drives the real ProcessHost through its public API with a Worker double
 * whose `postMessage` is `structuredClone` (what the browser does: serialize on
 * the page, deserialize in the Worker) followed by the worker side's `receive`
 * of the start message, which mounts the file system. The command does not
 * exist, so the program part is a constant "command not found".
 *
 * Measured per spawn, in ms (median of RUNS):
 *   total    — the whole `spawnChild` call (the double clones and mounts inline).
 *   snapshot — total − clone − mount: the page building what it sends.
 *   clone    — structuredClone of the start message (page serialize + worker deserialize).
 *   mount    — the worker's handling of `start` (file system ready + program lookup).
 * Scenarios: the first spawn of a project, a repeat spawn with nothing changed,
 * and a spawn right after one file was edited.
 */
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import { createWorkerProcess } from '../src/node/workerProcess.js';
import type { HostToWorker } from '../src/node/protocol.js';

const SIZES = [100, 1_000, 10_000];
const RUNS = 7;

interface Sample {
  host: number;
  clone: number;
  mount: number;
}

/** A project of `count` files: ~1.5 KB of source each, one in ten binary. */
function project(count: number): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  const line = 'export const value = "the quick brown fox jumps over the lazy dog";\n';
  for (let i = 0; i < count; i++) {
    const dir = `/node_modules/pkg${i % 200}/lib/sub${i % 7}`;
    if (i % 10 === 9) {
      const bytes = new Uint8Array(1536);
      for (let b = 0; b < bytes.length; b++) bytes[b] = (b * 31 + i) & 0xff;
      fs.writeFile(`${dir}/asset${i}.wasm`, bytes);
    } else fs.writeFile(`${dir}/file${i}.js`, `// file ${i}\n` + line.repeat(22));
  }
  fs.mkdir('/empty/dir');
  return fs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function benchHost(fs: VirtualFileSystem) {
  let last: Sample = { host: 0, clone: 0, mount: 0 };
  const createWorker = (): WorkerLike => {
    let alive = true;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        const t0 = performance.now();
        const copy = structuredClone(message) as HostToWorker;
        const t1 = performance.now();
        if (copy.type === 'start') {
          last.clone = t1 - t0;
          proc.receive(copy);
          last.mount = performance.now() - t1;
        } else queueMicrotask(() => alive && proc.receive(copy));
      },
      terminate() {
        alive = false;
      },
    };
    const proc = createWorkerProcess({
      post: (message) => queueMicrotask(() => alive && worker.onmessage?.({ data: structuredClone(message) })),
      fetch: () => Promise.reject(new Error('offline')),
    });
    return worker;
  };
  const host = new ProcessHost({ fs, createWorker, previewOrigin: 'https://bench.test', previewBase: '/__bfwc/b/', packageCache: false });
  const spawn = async (): Promise<Sample> => {
    last = { host: 0, clone: 0, mount: 0 };
    const t0 = performance.now();
    const child = host.spawnChild('bench-no-such-command');
    const hostMs = performance.now() - t0;
    await child.exit;
    return { ...last, host: hostMs };
  };
  return { host, spawn };
}

const fmt = (n: number) => n.toFixed(2).padStart(8);

async function main(): Promise<void> {
  console.log(`node ${process.version}; median of ${RUNS} runs; ms`);
  console.log('files  | scenario       |    total | snapshot |    clone |    mount');
  for (const size of SIZES) {
    const scenarios: Record<string, Sample[]> = { 'first spawn': [], 'repeat spawn': [], 'after 1 edit': [] };
    for (let run = 0; run < RUNS; run++) {
      const fs = project(size);
      const { host, spawn } = benchHost(fs);
      scenarios['first spawn']!.push(await spawn());
      scenarios['repeat spawn']!.push(await spawn());
      fs.writeFile('/src/edited.ts', `export const run = ${run};\n`);
      await Promise.resolve();
      scenarios['after 1 edit']!.push(await spawn());
      host.dispose();
    }
    for (const [name, samples] of Object.entries(scenarios)) {
      console.log(
        `${String(size).padStart(6)} | ${name.padEnd(14)} | ${fmt(median(samples.map((s) => s.host)))} | ${fmt(median(samples.map((s) => s.host - s.clone - s.mount)))} | ${fmt(median(samples.map((s) => s.clone)))} | ${fmt(median(samples.map((s) => s.mount)))}`,
      );
    }
  }
}

void main();
