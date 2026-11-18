/**
 * The `node` runtime provider: runs an application service's command (`node
 * server.js`, `npm run dev`) as a process of this runtime (`runtime.run()`), and
 * tells when it is ready from the runtime's own server signals (`port`), an
 * in-runtime localhost health check (`http`), or a clean exit (`exit-zero`).
 * What it cannot run it declines with a reason, so a host can pick another target.
 */
import { readinessOf, type Acceptance, type ReadinessKind, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { untilHttpHealthy, type NodeServiceHost } from './nodeReadiness.js';
import type { RuntimeProcess, ServerAddress } from '@seanhogg/builderforce-webcontainers-core';

/** Commands the browser runtime cannot host, by name, with the reason it gives. */
export const NODE_DECLINED_COMMANDS: Readonly<Record<string, string>> = {
  docker: 'Docker cannot run in the browser runtime.',
  'docker-compose': 'Docker cannot run in the browser runtime.',
  wrangler: '`wrangler dev` needs workerd (Miniflare), which cannot run in the browser runtime.',
  miniflare: 'Miniflare needs workerd, which cannot run in the browser runtime.',
  nuxt: "Nuxt's dev server does not run in the browser runtime yet.",
  nuxi: "Nuxt's dev server does not run in the browser runtime yet.",
};

/** Which readiness kinds a Node service can be held to. `query` belongs to database providers. */
export const NODE_READINESS: Readonly<Record<ReadinessKind, boolean>> = { port: true, http: true, 'exit-zero': true, query: false };

export interface NodeProviderOptions {
  /** Between `http` readiness probes. Default 250ms. */
  probeIntervalMs?: number;
}

const basename = (token: string) => token.replace(/\\/g, '/').split('/').pop() ?? token;

export function acceptsNodeService(service: ServiceSpec): Acceptance {
  if (service.type !== 'application') return { ok: false, reason: `The node runtime runs application services; "${service.id}" is a ${service.type} service.` };
  const readiness = readinessOf(service).kind;
  if (!NODE_READINESS[readiness]) return { ok: false, reason: `"${readiness}" readiness is for databases; service "${service.id}" runs on node.` };
  for (const token of [service.command ?? '', ...(service.args ?? [])]) {
    const reason = NODE_DECLINED_COMMANDS[basename(token)];
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

export function createNodeProvider(host: NodeServiceHost, options: NodeProviderOptions = {}): RuntimeProvider {
  const probeIntervalMs = options.probeIntervalMs ?? 250;
  return {
    id: 'node',
    accepts: acceptsNodeService,
    start(service, context) {
      const readiness = readinessOf(service);
      const port = service.port;
      let url: string | undefined;
      let opened!: () => void;
      const portOpen = new Promise<void>((resolve) => (opened = resolve));
      const onOpen = (address: ServerAddress) => {
        if (address.port !== port) return;
        url = address.url;
        opened();
      };
      // Subscribed before the process starts, so an early `listen` is not missed.
      const unsubscribe = [
        host.onServerListening(onOpen),
        host.onPortChange((change) => (change.type === 'open' ? onOpen(change) : change.port === port && (url = undefined))),
      ];
      let child: RuntimeProcess;
      try {
        child = host.run(service.command!, service.args ?? [], { cwd: service.root ?? '/', env: context.env });
      } catch (error) {
        unsubscribe.forEach((stop) => stop());
        throw error;
      }

      // Probing stops when the process exits or the application gives up on it.
      const probing = new AbortController();
      const stopProbing = () => probing.abort();
      context.signal.addEventListener('abort', stopProbing, { once: true });
      const exit = child.wait().then((code) => {
        url = undefined;
        unsubscribe.forEach((stop) => stop());
        stopProbing();
        return code;
      });
      const exitsBefore = (what: string) =>
        exit.then((code): never => {
          throw new Error(`Exited with code ${code} before ${what}.`);
        });

      let readiness$: Promise<void> | undefined;
      const ready = (): Promise<void> => {
        switch (readiness.kind) {
          case 'port':
            return Promise.race([portOpen, exitsBefore(`opening port ${port}`)]);
          case 'http':
            return Promise.race([portOpen.then(() => untilHttpHealthy(host, port!, readiness.path, probeIntervalMs, probing.signal)), exitsBefore(`answering ${readiness.path}`)]);
          case 'exit-zero':
            return exit.then((code) => {
              if (code !== 0) throw new Error(`Exited with code ${code}.`);
            });
          case 'query':
            return Promise.reject(new Error('The node runtime cannot check "query" readiness.'));
        }
      };

      return {
        output: child.combinedOutput,
        ready: () => (readiness$ ??= ready()),
        wait: () => exit,
        kill: (signal) => child.kill(signal),
        url: () => url,
      };
    },
  };
}
