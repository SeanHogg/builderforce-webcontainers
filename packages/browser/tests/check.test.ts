import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChecker, checkInputs, DEFAULT_TYPESCRIPT_URL, TYPESCRIPT_VERSION } from '../src/check/index.js';
import { CHECK, CHECK_ERROR, CHECK_RESULT, isCheckInput, type CheckRequest } from '../src/check/protocol.js';
import { createCachedFetch } from '../src/check/cachedFetch.js';

/** A Worker stand-in: records posted requests and lets the test answer them. */
function fakeWorker() {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const posted: CheckRequest[] = [];
  const worker = {
    terminated: false,
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners[type] ??= []).push(listener);
    },
    postMessage(message: CheckRequest) {
      posted.push(message);
    },
    terminate() {
      this.terminated = true;
    },
    emit(type: string, event: unknown) {
      for (const listener of listeners[type] ?? []) listener(event);
    },
  };
  return { worker, posted };
}

describe('createChecker', () => {
  it('sends only source and config files, and resolves each check with its own result', async () => {
    const { worker, posted } = fakeWorker();
    const checker = createChecker({ createWorker: () => worker as unknown as Worker });
    const pending = checker.check({ 'src/a.ts': 'x', 'src/logo.png': new Uint8Array([1]), 'tsconfig.json': '{}', 'node_modules/x/index.d.ts': '' });
    expect(posted[0]).toMatchObject({ type: CHECK, id: 1, typescriptUrl: DEFAULT_TYPESCRIPT_URL, files: { 'src/a.ts': 'x', 'tsconfig.json': '{}' } });
    expect(Object.keys(posted[0]!.files)).toHaveLength(2);
    const result = { diagnostics: [], untypedPackages: [], files: ['src/a.ts'] };
    worker.emit('message', { data: { type: CHECK_RESULT, id: 1, result, durationMs: 5 } });
    await expect(pending).resolves.toEqual({ ...result, durationMs: 5 });
  });

  it('rejects on a worker error reply, and every pending check on dispose', async () => {
    const { worker } = fakeWorker();
    const checker = createChecker({ createWorker: () => worker as unknown as Worker, typescriptUrl: 'https://x/ts.js' });
    const failing = checker.check({});
    worker.emit('message', { data: { type: CHECK_ERROR, id: 1, message: 'boom' } });
    await expect(failing).rejects.toThrow('boom');
    const pending = checker.check({});
    checker.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(worker.terminated).toBe(true);
  });

  it('pins TypeScript', () => {
    expect(DEFAULT_TYPESCRIPT_URL).toBe(`https://cdn.jsdelivr.net/npm/typescript@${TYPESCRIPT_VERSION}/lib/typescript.js`);
    expect(isCheckInput('/src/a.vue')).toBe(false);
    expect(checkInputs({ 'a.d.ts': 'declare const a: 1;' })).toEqual({ 'a.d.ts': 'declare const a: 1;' });
  });
});

describe('createCachedFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  function network() {
    const calls: string[] = [];
    const base = (async (url: string) => {
      calls.push(url);
      return new Response(`body of ${url}`, { headers: { 'x-typescript-types': 'https://esm.sh/t.d.ts' } });
    }) as unknown as typeof fetch;
    return { calls, base };
  }

  it('serves exact-version files from Cache Storage after the first fetch, keeping headers', async () => {
    const entries = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (url: string) => entries.get(url)?.clone(),
        put: async (url: string, response: Response) => void entries.set(url, response),
      }),
    });
    const { calls, base } = network();
    const fetchTypes = createCachedFetch(base);
    const url = 'https://esm.sh/@types/react@18.3.9/index.d.ts';
    await fetchTypes(url);
    const again = await fetchTypes(url);
    expect(calls).toEqual([url]);
    expect(await again.text()).toBe(`body of ${url}`);
    expect(again.headers.get('X-TypeScript-Types')).toBe('https://esm.sh/t.d.ts');
  });

  it('always fetches range lookups, and works without Cache Storage', async () => {
    const { calls, base } = network();
    const fetchTypes = createCachedFetch(base);
    await fetchTypes('https://esm.sh/react@^18.3.1');
    await fetchTypes('https://esm.sh/react@^18.3.1');
    await fetchTypes('https://esm.sh/@types/react@18.3.9/index.d.ts');
    expect(calls).toHaveLength(3);
  });
});
