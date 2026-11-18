/**
 * Readiness checks for services running on the in-browser Node runtime: a port
 * opening (the runtime's own server signals), and a health URL answering over
 * the runtime's in-runtime localhost — never the page's network.
 */
import type { PortChange, ProcessOptions, RuntimeProcess, ServerAddress } from '@seanhogg/builderforce-webcontainers-core';
import { exitWithin } from './stopProcess.js';

/** The slice of a runtime (`startPreviewRuntime()`'s, or the core `Kernel` adapted) the Node provider uses. */
export interface NodeServiceHost {
  run(command: string, args: string[], options?: ProcessOptions): RuntimeProcess;
  /** A server started listening on a port (or a dev script handed off to the preview). */
  onServerListening(listener: (server: ServerAddress) => void): () => void;
  /** A virtual server opened or closed its port. */
  onPortChange(listener: (change: PortChange) => void): () => void;
  /**
   * Send a request to a virtual server directly, without a process (the core
   * `Kernel.request`). Without it, `http` readiness probes from inside the
   * runtime with a short `node -e` fetch to localhost.
   */
  request?(port: number, request: { url: string }): Promise<{ status: number } | undefined>;
}

/** 2xx and 3xx count as answering. */
export const isHealthy = (status: number) => status >= 200 && status < 400;

/** A program the runtime's Node runs: exits 0 when `GET url` is healthy, 1 otherwise. */
export function httpProbeScript(url: string): string {
  return `fetch(${JSON.stringify(url)}).then((r) => process.exit(r.status >= 200 && r.status < 400 ? 0 : 1), () => process.exit(1));`;
}

/** Ask once whether `http://localhost:<port><path>` is healthy, from inside the runtime. */
export async function probeHttp(host: NodeServiceHost, port: number, path: string, timeoutMs: number): Promise<boolean> {
  const url = path.startsWith('/') ? path : `/${path}`;
  if (host.request) {
    const response = await host.request(port, { url }).catch(() => undefined);
    return response !== undefined && isHealthy(response.status);
  }
  const probe = host.run('node', ['-e', httpProbeScript(`http://localhost:${port}${url}`)]);
  void probe.combinedOutput.cancel().catch(() => undefined);
  const code = await exitWithin(probe, timeoutMs);
  if (code === undefined) probe.kill('SIGKILL');
  return code === 0;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Probe until healthy; rejects when `signal` aborts (the process exited, the service stopped). */
export async function untilHttpHealthy(host: NodeServiceHost, port: number, path: string, intervalMs: number, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw new Error(`Gave up waiting for http://localhost:${port}${path}.`);
    if (await probeHttp(host, port, path, Math.max(intervalMs * 4, 2000))) return;
    await sleep(intervalMs, signal);
  }
}
