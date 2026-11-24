/**
 * The `env.*` tool port (W12 phase 3): allowlist and idempotency-key checks
 * before dispatch, Shield events for refusals, `env.run`'s timeout and output
 * cap, workspace-path confinement and own-service-only fetches.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, type HttpResponseData, type RuntimeProcess } from '@seanhogg/builderforce-webcontainers-core';
import { createEnvironmentToolPort, ENV_OUTPUT_LIMIT_BYTES, type EnvironmentToolPortDeps } from '../../src/agents.js';
import { createShieldTelemetry } from '../../src/security.js';
import type { ServiceSnapshot } from '../../src/app.js';

const KEY = { runId: 'run-1', step: 1, toolCallId: 'call-1' };
const ALL_TOOLS = ['env.fs.read', 'env.fs.write', 'env.fs.list', 'env.run', 'env.preview.fetch', 'env.services.status'];

/** A process that writes `chunks` and exits with `exitCode` — or never exits when `exitCode` is null. */
function fakeProcess(chunks: string[], exitCode: number | null): RuntimeProcess & { killed: string[] } {
  const killed: string[] = [];
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  if (exitCode !== null) exit(exitCode);
  return {
    pid: 1,
    killed,
    combinedOutput: new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (exitCode !== null) controller.close();
      },
    }),
    stdin: new WritableStream<string>(),
    wait: () => exited,
    kill(signal = 'SIGTERM') {
      killed.push(signal);
      exit(137);
    },
    resizeTerminal() {},
  };
}

const service = (id: string, port?: number): ServiceSnapshot => ({ id, type: 'application', runtime: 'node', role: 'backend', state: 'ready', port, restarts: 0 });

function setup(overrides: { process?: RuntimeProcess; timeoutMs?: number; tools?: string[] } = {}) {
  const shield = createShieldTelemetry();
  const fs = new VirtualFileSystem();
  fs.writeFile('/src/index.ts', 'export {};');
  const requests: Array<{ port: number; url: string }> = [];
  const runs: Array<{ command: string; args: string[] | undefined }> = [];
  const deps: EnvironmentToolPortDeps = {
    fs,
    shield,
    timeoutMs: overrides.timeoutMs,
    app: { applicationId: 'app:shop', listServices: () => [service('web', 3000), service('api', 4000)] },
    runtime: {
      run: ((command: string, args?: string[]) => {
        runs.push({ command, args });
        return overrides.process ?? fakeProcess(['ok\n'], 0);
      }) as EnvironmentToolPortDeps['runtime']['run'],
      async request(port, request): Promise<HttpResponseData | undefined> {
        requests.push({ port, url: request.url });
        return { status: 200, headers: {}, body: new TextEncoder().encode('healthy') };
      },
    },
  };
  const port = createEnvironmentToolPort(deps, { id: 'developer', tools: overrides.tools ?? ALL_TOOLS });
  return { port, shield, fs, requests, runs };
}

describe('environment tool port', () => {
  it('refuses a tool outside the allowlist with tool-not-allowed and a Shield event, before dispatch', async () => {
    const { port, shield, runs } = setup({ tools: ['env.fs.read'] });
    const result = await port.call('env.run', { command: 'rm', args: ['-rf', '/'] }, KEY);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'tool-not-allowed', tool: 'env.run' } });
    expect(runs).toEqual([]);
    const events = shield.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reasonCode: 'agent.tool_not_allowed', ruleId: 'agent.tool-allowlist' });
    expect(events[0]!.evidence).toMatchObject({ agentId: 'developer', tool: 'env.run' });
  });

  it('refuses a mutating call without an idempotency key', async () => {
    const { port, fs } = setup();
    const result = await port.call('env.fs.write', { path: 'src/a.ts', content: 'x' });
    expect(result).toMatchObject({ ok: false, refusal: { code: 'tool-not-allowed', tool: 'env.fs.write' } });
    expect(fs.exists('/src/a.ts')).toBe(false);
    expect(port.mutates['env.fs.write']).toBe(true);
  });

  it('reads, writes and lists project-relative paths', async () => {
    const { port, fs } = setup();
    expect(await port.call('env.fs.write', { path: 'src/a.ts', content: 'export const a = 1;' }, KEY)).toMatchObject({ ok: true });
    expect(fs.readText('/src/a.ts')).toBe('export const a = 1;');
    expect(await port.call('env.fs.read', { path: 'src/a.ts' })).toEqual({ ok: true, result: { path: '/src/a.ts', found: true, content: 'export const a = 1;' } });
    expect(await port.call('env.fs.list', { path: 'src' })).toMatchObject({ ok: true, result: { entries: expect.arrayContaining([{ name: 'a.ts', kind: 'file' }]) } });
  });

  it.each(['../secrets.txt', 'src/../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini'])('refuses the path %s', async (path) => {
    const { port, shield } = setup();
    const result = await port.call('env.fs.read', { path });
    expect(result).toMatchObject({ ok: false, refusal: { code: 'shield-denied', tool: 'env.fs.read' } });
    expect(shield.events().map((event) => event.reasonCode)).toEqual(['agent.path_invalid']);
  });

  it('runs a command and returns its exit code and output', async () => {
    const { port, runs } = setup({ process: fakeProcess(['3 passed\n'], 0) });
    expect(await port.call('env.run', { command: 'npm', args: ['test'] }, KEY)).toEqual({ ok: true, result: { exitCode: 0, output: '3 passed\n', truncated: false } });
    expect(runs).toEqual([{ command: 'npm', args: ['test'] }]);
  });

  it('kills a command past the timeout and refuses with timeout', async () => {
    const process = fakeProcess(['starting\n'], null);
    const { port } = setup({ process, timeoutMs: 20 });
    const result = await port.call('env.run', { command: 'node', args: ['hang.js'] }, KEY);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'timeout', tool: 'env.run' } });
    expect(process.killed).toEqual(['SIGKILL']);
  });

  it('caps output at 256 KB and flags it truncated', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const { port } = setup({ process: fakeProcess(Array.from({ length: 6 }, () => chunk), 0) });
    const result = await port.call('env.run', { command: 'cat', args: ['big.log'] }, KEY);
    expect(result.ok).toBe(true);
    const { output, truncated } = (result as { result: { output: string; truncated: boolean } }).result;
    expect(output.length).toBe(ENV_OUTPUT_LIMIT_BYTES);
    expect(truncated).toBe(true);
  });

  it('fetches from its own service by id, on that service’s port', async () => {
    const { port, requests } = setup();
    expect(await port.call('env.preview.fetch', { service: 'api', path: '/health' })).toMatchObject({ ok: true, result: { status: 200, body: 'healthy', truncated: false } });
    expect(requests).toEqual([{ port: 4000, url: '/health' }]);
  });

  it.each([
    { service: 'billing', path: '/' },
    { service: 'api', path: '//evil.example/steal' },
    { service: 'api', path: 'http://169.254.169.254/latest/meta-data' },
  ])('refuses a fetch outside the environment’s own services (%o)', async (args) => {
    const { port, requests, shield } = setup();
    const result = await port.call('env.preview.fetch', args);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'shield-denied', tool: 'env.preview.fetch' } });
    expect(requests).toEqual([]);
    expect(shield.events().map((event) => event.reasonCode)).toEqual(['agent.service_not_allowed']);
  });

  it('reports service status', async () => {
    const { port } = setup();
    expect(await port.call('env.services.status', {})).toMatchObject({ ok: true, result: [{ id: 'web', port: 3000 }, { id: 'api', port: 4000 }] });
  });
});
