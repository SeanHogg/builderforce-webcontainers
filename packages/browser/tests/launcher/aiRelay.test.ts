/**
 * The launcher's model relay (contract §6): `POST /__bf/ai` on the page origin,
 * behind the launch token, bounded, streamed, never on a preview origin; and the
 * page-side `HostRelay` that calls it. Needs the built package, like server.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createLocalLauncher, type LauncherForwardAi } from '../../src/launcher/server/index.js';
import { parseAiRelayEnvelope } from '../../src/launcher/server/aiRelay.js';
import { LAUNCH_PATHS, LAUNCH_TOKEN_HEADER, type AiRelayEnvelope, type LaunchInfo } from '../../src/launcher/protocol.js';
import { launcherHostRelay } from '../../src/launcher/page/aiRelay.js';
import { encodeBase64 } from '../../src/launcher/page/bootApplication.js';
import { NODE_MANIFEST, get, launcherRequest, tempProject, tokenOf, trustCa } from './launcherHelpers.js';

const KEY = '0123456789abcdef0123456789abcdef';
const encoder = new TextEncoder();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const CA_DIR = mkdtempSync(join(tmpdir(), 'bfwc-ai-ca-'));
afterAll(() => rmSync(CA_DIR, { recursive: true, force: true }));

async function launch(forwardAi?: LauncherForwardAi) {
  const project = tempProject({ 'builderforce.json': NODE_MANIFEST });
  cleanups.push(project.cleanup);
  const launcher = await createLocalLauncher({ projectDir: project.dir, tls: { storeDir: CA_DIR }, forwardAi });
  trustCa(launcher.caCertPath ? readFileSync(launcher.caCertPath, 'utf8') : undefined);
  cleanups.push(() => launcher.close());
  const auth = { [LAUNCH_TOKEN_HEADER]: tokenOf(launcher.url), 'Content-Type': 'application/json' };
  return { launcher, port: launcher.port, host: `localhost:${launcher.port}`, auth };
}

const envelope = (extra: Partial<AiRelayEnvelope> = {}): string =>
  JSON.stringify({ resourceId: 'chat', stream: true, body: encodeBase64(encoder.encode('{"model":"m"}')), ...extra });

async function* chunked(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

/** `get` with a body: the helper sends none, so a POST goes through `launcherRequest`. */
function post(port: number, host: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = launcherRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { Host: host, 'Content-Length': String(Buffer.byteLength(body)), ...headers } });
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('POST /__bf/ai', () => {
  it('refuses a missing or wrong token with 403', async () => {
    const { port, host } = await launch(() => chunked('x'));
    expect((await post(port, host, LAUNCH_PATHS.ai, {}, envelope())).status).toBe(403);
    expect((await post(port, host, LAUNCH_PATHS.ai, { [LAUNCH_TOKEN_HEADER]: 'wrong' }, envelope())).status).toBe(403);
  });

  it('answers 405 to a GET and 404 when the host supplied no relay', async () => {
    const withRelay = await launch(() => chunked('x'));
    expect((await get(withRelay.port, withRelay.host, LAUNCH_PATHS.ai, withRelay.auth)).status).toBe(405);
    const without = await launch();
    expect((await post(without.port, without.host, LAUNCH_PATHS.ai, without.auth, envelope())).status).toBe(404);
  });

  it('relays the host callback’s chunks, passing the resource facts and no headers', async () => {
    const seen: Parameters<LauncherForwardAi>[0][] = [];
    const { port, host, auth } = await launch((request) => {
      seen.push(request);
      return chunked('data: a\n\n', 'data: b\n\n');
    });
    const response = await post(port, host, LAUNCH_PATHS.ai, auth, envelope({ models: ['m'] }));
    expect(response.status).toBe(200);
    expect(response.body).toBe('data: a\n\ndata: b\n\n');
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(seen[0]).toMatchObject({ resourceId: 'chat', models: ['m'], stream: true });
    expect(new TextDecoder().decode(seen[0]!.body)).toBe('{"model":"m"}');
  });

  it('answers 400 to a bad envelope and 502 when the relay fails on its first chunk', async () => {
    const { port, host, auth } = await launch(async function* () {
      throw new Error('not signed in');
    });
    expect((await post(port, host, LAUNCH_PATHS.ai, auth, 'not json')).status).toBe(400);
    expect((await post(port, host, LAUNCH_PATHS.ai, auth, envelope({ resourceId: '../x' }))).status).toBe(400);
    const failed = await post(port, host, LAUNCH_PATHS.ai, auth, envelope());
    expect(failed.status).toBe(502);
    expect(failed.body).toContain('not signed in');
  });

  it('is never served on a preview origin, and launch.json reports whether a relay exists', async () => {
    const { port, auth, host } = await launch(() => chunked('x'));
    const onPreview = await post(port, `${KEY}.localhost:${port}`, LAUNCH_PATHS.ai, auth, envelope());
    expect(onPreview.status).not.toBe(200);
    const info = JSON.parse((await get(port, host, LAUNCH_PATHS.launch, auth)).body) as LaunchInfo;
    expect(info.aiRelay).toBe(true);
    const bare = await launch();
    expect((JSON.parse((await get(bare.port, bare.host, LAUNCH_PATHS.launch, bare.auth)).body) as LaunchInfo).aiRelay).toBe(false);
  });
});

describe('parseAiRelayEnvelope', () => {
  const ok = { resourceId: 'chat', stream: false, body: 'e30=' };
  it('accepts a well-formed envelope', () => {
    expect(parseAiRelayEnvelope(ok)).toMatchObject({ resourceId: 'chat', stream: false });
  });
  it('refuses every malformed field', () => {
    for (const bad of [null, 'x', { ...ok, resourceId: '' }, { ...ok, resourceId: 'a/b' }, { ...ok, stream: 'yes' }, { ...ok, body: '***' }, { ...ok, models: 'm' }, { ...ok, models: Array(65).fill('m') }, { ...ok, models: ['x'.repeat(201)] }]) {
      expect(typeof parseAiRelayEnvelope(bad), JSON.stringify(bad)).toBe('string');
    }
  });
});

describe('launcherHostRelay (page side)', () => {
  it('posts the envelope with the launch token and yields the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('answer');
    }) as unknown as typeof fetch;
    const relay = launcherHostRelay('tok', fetchImpl);
    let text = '';
    for await (const chunk of relay.forwardAi({ resourceId: 'chat', models: ['m'], body: encoder.encode('hi'), stream: false })) text += new TextDecoder().decode(chunk);
    expect(text).toBe('answer');
    expect(calls[0]!.url).toBe(LAUNCH_PATHS.ai);
    expect((calls[0]!.init.headers as Record<string, string>)[LAUNCH_TOKEN_HEADER]).toBe('tok');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ resourceId: 'chat', models: ['m'], stream: false, body: encodeBase64(encoder.encode('hi')) });
  });

  it('throws on a non-ok answer, and the vault stays unfilled', async () => {
    const relay = launcherHostRelay('tok', (async () => new Response('no', { status: 502 })) as unknown as typeof fetch);
    await expect(relay.forwardAi({ resourceId: 'chat', body: new Uint8Array(), stream: false })[Symbol.asyncIterator]().next()).rejects.toThrow('AI relay answered 502');
    await expect(relay.connectionSecrets('c')).rejects.toThrow();
  });
});
