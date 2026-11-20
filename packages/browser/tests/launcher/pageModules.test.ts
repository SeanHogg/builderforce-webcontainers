/**
 * The launcher page's small pure modules: the launch token, server-sent-event
 * parsing and the change client, live sync into the runtime's file system, the
 * bounded log buffer and the labels.
 */
import { describe, expect, it, vi } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { formatLabel, resolveLabels, DEFAULT_LAUNCHER_LABELS } from '../../src/launcher/labels.js';
import { LAUNCH_TOKEN_HEADER } from '../../src/launcher/protocol.js';
import { createLaunchClient, parseServerEvents, readLaunchToken } from '../../src/launcher/page/launchConfig.js';
import { applyChange, runtimePathOf, startLiveSync } from '../../src/launcher/page/liveSync.js';
import { LogBuffer } from '../../src/launcher/page/logBuffer.js';
import { probeOrigins, probeUrlsOf } from '../../src/launcher/page/originProbe.js';

describe('readLaunchToken', () => {
  it('reads #token=… and refuses anything malformed', () => {
    expect(readLaunchToken('#token=abcdefghijklmnop_-12')).toBe('abcdefghijklmnop_-12');
    expect(readLaunchToken('')).toBeNull();
    expect(readLaunchToken('#token=short')).toBeNull();
    expect(readLaunchToken('#token=has%20space%20in%20it%20xx')).toBeNull();
  });
});

describe('parseServerEvents', () => {
  it('splits complete events, keeps the unterminated rest, skips comments', () => {
    const { events, rest } = parseServerEvents(': connected\n\ndata: {"a":1}\n\nevent: error\ndata: {"message":"x"}\r\n\r\ndata: {"b"');
    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'error', data: '{"message":"x"}' },
    ]);
    expect(rest).toBe('data: {"b"');
  });
});

describe('createLaunchClient', () => {
  it('sends the token on every request and follows the change stream until it ends', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const body = 'data: {"path":"a.txt","content":"A"}\n\nevent: error\ndata: {"message":"watch failed"}\n\n';
    const fetchImpl = vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      if (input === '/__bf/changes') return new Response(new Blob([body]).stream(), { status: 200 });
      return new Response(JSON.stringify({ files: {}, binary: {}, skipped: [] }), { status: 200 });
    });
    const client = createLaunchClient('tok-tok-tok-tok-tok', fetchImpl);
    expect(await client.files()).toEqual({ files: {}, binary: {}, skipped: [] });
    const changes: unknown[] = [];
    const errors: string[] = [];
    await client.followChanges({ change: (change) => changes.push(change), error: (message) => errors.push(message) }, new AbortController().signal);
    expect(seen.every((headers) => headers?.[LAUNCH_TOKEN_HEADER] === 'tok-tok-tok-tok-tok')).toBe(true);
    expect(changes).toEqual([{ path: 'a.txt', content: 'A' }]);
    expect(errors).toEqual(['watch failed', 'The change stream ended.']);
  });

  it('reports a refused request with its status', async () => {
    const client = createLaunchClient('tok-tok-tok-tok-tok', async () => new Response('no', { status: 403 }));
    await expect(client.launch()).rejects.toThrow(/403/);
  });
});

describe('live sync', () => {
  function memoryFs() {
    const files = new Map<string, string | Uint8Array>();
    return {
      files,
      writeFile: (path: string, contents: string | Uint8Array) => void files.set(path, contents),
      rm: (path: string) => void files.delete(path),
      exists: (path: string) => files.has(path),
    };
  }

  it('maps only plain project-relative paths', () => {
    expect(runtimePathOf('src/a.ts')).toBe('/src/a.ts');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a\\b', 'a//b', './a']) expect(runtimePathOf(bad), bad).toBeNull();
  });

  it('writes text and bytes, removes deletions, and reports what it could not apply', () => {
    const fs = memoryFs();
    const skipped: string[] = [];
    const handlers = { skipped: (path: string) => skipped.push(path) };
    expect(applyChange(fs, { path: 'a.txt', content: 'A' }, handlers)).toBe(true);
    expect(applyChange(fs, { path: 'b.bin', base64: Buffer.from([1, 2]).toString('base64') }, handlers)).toBe(true);
    expect(Array.from(fs.files.get('/b.bin') as Uint8Array)).toEqual([1, 2]);
    expect(applyChange(fs, { path: 'a.txt', deleted: true }, handlers)).toBe(true);
    expect(fs.exists('/a.txt')).toBe(false);
    expect(applyChange(fs, { path: 'huge.bin', skipped: true }, handlers)).toBe(false);
    expect(applyChange(fs, { path: '../escape', content: 'x' }, handlers)).toBe(false);
    expect(skipped).toEqual(['huge.bin', '../escape']);
  });

  it('a deleted directory removes everything under it in the runtime’s file system', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ web: { src: { 'a.ts': 'a', 'b.ts': 'b' }, 'index.html': '<p>' }, 'keep.txt': 'k' });
    expect(applyChange(fs, { path: 'web', deleted: true }, { skipped: () => undefined })).toBe(true);
    expect(fs.exists('/web')).toBe(false);
    expect(fs.exists('/web/src/a.ts')).toBe(false);
    expect(fs.list()).toEqual(['/keep.txt']);
  });

  it('a change that cannot be written is reported and the stream goes on', async () => {
    const fs = { ...memoryFs(), writeFile: vi.fn(() => { throw new Error('EISDIR'); }) };
    const errors: string[] = [];
    const client = {
      launch: vi.fn(),
      files: vi.fn(),
      followChanges: vi.fn(async (handlers: { change(change: unknown): void }) => {
        handlers.change({ path: 'a', content: '1' });
        handlers.change({ path: 'b', content: '2' });
      }),
    };
    const stop = startLiveSync(client as never, fs, { skipped: () => undefined, error: (message) => errors.push(message) });
    await Promise.resolve();
    stop();
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['a: EISDIR', 'b: EISDIR']);
  });
});

describe('probeOrigins', () => {
  const INFO = { relayUrl: 'https://127.0.0.1:4000/__bfwc/relay.html', previewOriginTemplate: 'https://{key}.localhost:4000' };

  it('probes the relay and one *.localhost application origin, credential-free and uncached', async () => {
    expect(probeUrlsOf(INFO)).toEqual(['https://127.0.0.1:4000/__bfwc/probe', `https://${'0'.repeat(32)}.localhost:4000/__bfwc/probe`]);
    const seen: unknown[] = [];
    expect(await probeOrigins(INFO, async (input, init) => (seen.push([input, init]), { ok: true, status: 204 }))).toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual([expect.any(String), { mode: 'cors', cache: 'no-store', credentials: 'omit' }]);
  });

  it('names the first origin that does not resolve or is not trusted, with why', async () => {
    const failing = await probeOrigins(INFO, async (input) => {
      if (input.includes('.localhost')) throw new TypeError('Failed to fetch');
      return { ok: true, status: 204 };
    });
    expect(failing).toEqual({ origin: `https://${'0'.repeat(32)}.localhost:4000`, detail: 'Failed to fetch' });
    expect(await probeOrigins(INFO, async () => ({ ok: false, status: 403 }))).toEqual({ origin: 'https://127.0.0.1:4000', detail: 'HTTP 403' });
  });
});

describe('LogBuffer', () => {
  it('caps each view and counts what it dropped', () => {
    const buffer = new LogBuffer(3);
    for (let i = 0; i < 5; i++) buffer.push({ serviceId: i % 2 ? 'api' : 'web', source: 'output', text: String(i) });
    expect(buffer.view().lines.map((line) => line.text)).toEqual(['2', '3', '4']);
    expect(buffer.view().dropped).toBe(2);
    expect(buffer.view('web').lines.map((line) => line.text)).toEqual(['0', '2', '4']);
    expect(buffer.view('api')).toEqual({ lines: [expect.objectContaining({ text: '1' }), expect.objectContaining({ text: '3' })], dropped: 0 });
    expect(buffer.view('nope')).toEqual({ lines: [], dropped: 0 });
  });
});

describe('labels', () => {
  it('overrides only known string labels and fills placeholders', () => {
    const labels = resolveLabels({ restart: 'Neu starten', title: 42, bogus: 'x' } as never);
    expect(labels.restart).toBe('Neu starten');
    expect(labels.title).toBe(DEFAULT_LAUNCHER_LABELS.title);
    expect(labels).not.toHaveProperty('bogus');
    expect(formatLabel('Port {port} of {name}', { port: 3000 })).toBe('Port 3000 of {name}');
  });
});
