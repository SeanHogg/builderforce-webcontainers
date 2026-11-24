/**
 * The services recovery participant. Services hold no state of their own to
 * persist — their files and databases were recovered by the stages before — so
 * recovery re-enters `startApplicationRuntime` with the application's spec and
 * waits for every service to be `ready`.
 */
import type { ApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { startApplicationRuntime } from '../app/startApplicationRuntime.js';
import type { ApplicationRuntime, ApplicationRuntimeOptions } from '../app/types.js';
import type { RecoveryParticipant } from './environmentRecovery.js';

export type ApplicationStarter = (spec: ApplicationSpec, options: ApplicationRuntimeOptions) => ApplicationRuntime;

export interface ServiceParticipantOptions {
  spec: ApplicationSpec;
  runtimeOptions: ApplicationRuntimeOptions;
  /** Default `startApplicationRuntime`. */
  start?: ApplicationStarter;
  /** Hands the host the runtime recovery started (to stop it, reach its databases, …). */
  onRuntime?(runtime: ApplicationRuntime): void;
  /** Default `services`. */
  id?: string;
  dependsOn?: string[];
}

export function createServiceParticipant(options: ServiceParticipantOptions): RecoveryParticipant {
  const id = options.id ?? 'services';
  const start = options.start ?? startApplicationRuntime;
  return {
    id,
    stage: 'services',
    dependsOn: options.dependsOn,
    // Nothing to persist: a service is restarted from its spec.
    checkpoint: async () => undefined,
    async recover() {
      const runtime = start(options.spec, options.runtimeOptions);
      options.onRuntime?.(runtime);
      await runtime.start();
      const waiting = runtime.listServices().filter((service) => service.state !== 'ready');
      if (waiting.length) return { id, status: 'failed', detail: `Not ready: ${waiting.map((service) => `${service.id} (${service.state})`).join(', ')}.` };
      return { id, status: 'restored' };
    },
  };
}
