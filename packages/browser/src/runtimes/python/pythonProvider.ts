/**
 * The `python` runtime provider for `startApplicationRuntime`: a service whose
 * command is Python (`python app.py`, `uvicorn main:app --port 8000`, `flask
 * run`, `gunicorn app:app`) runs as a Python process of the runtime — the
 * process host gives Python commands a Python Worker — and is held to the same
 * readiness as a Node service (its port opening, a health URL, a clean exit):
 * the Node provider's start is reused as is. What it cannot run it declines
 * with a reason: non-Python commands, and native-only requirements, each named,
 * so the host can send the application to the container target.
 *
 * A `training` service (`python train.py`) runs its entry point the same way,
 * with no server: ready once started, never restarted, asked to checkpoint
 * before it is stopped (`bfwc.training`; page side trainingChannel.ts, worker
 * side trainingControl.ts — pass the policy's `training` here). `import torch`
 * comes from a host extension (`PythonHostOptions.extensions`): the host's
 * module returns `@webdit/torch/pyodide`'s `torchPythonExtension(bridge)` —
 * the runtime takes no dependency on it — and lists `provides: ['torch',
 * 'peft']` here so requirements naming them are not declined.
 */
import { readinessOf, type Acceptance, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { createNodeProvider, type NodeProviderOptions } from '../../app/nodeProvider.js';
import type { NodeServiceHost } from '../../app/nodeReadiness.js';
import { isPythonCommand, parsePythonCommand } from './pythonCommand.js';
import { resolveFrom } from '@seanhogg/builderforce-webcontainers-core';
import { normalizeName, planRequirements, readProjectRequirements } from './requirements.js';
import type { TrainingServices } from './trainingChannel.js';

export interface PythonProviderOptions extends NodeProviderOptions {
  /** The project's files: with them, a service whose requirements include native-only packages is declined up front, by name. */
  fs?: VirtualFileSystem;
  /** Packages the host's Python extensions provide (`torch`): never declined. */
  provides?: readonly string[];
  /** Training services' page side: the Python process-kind policy's `training` (`createPythonProcessKind({ training })`). */
  training?: TrainingServices;
}

export function acceptsPythonService(service: ServiceSpec, fs?: VirtualFileSystem, provides: readonly string[] = []): Acceptance {
  if (service.type !== 'application' && service.type !== 'training') return { ok: false, reason: `The python runtime runs application and training services; "${service.id}" is a ${service.type} service.` };
  if (readinessOf(service).kind === 'query') return { ok: false, reason: `"query" readiness is for databases; service "${service.id}" runs on python.` };
  const command = service.command;
  if (!command || !isPythonCommand(command)) return { ok: false, reason: `Service "${service.id}": "${command ?? ''}" is not a Python command (python, pip, uvicorn, gunicorn, hypercorn, waitress-serve, flask, fastapi).` };
  const parsed = parsePythonCommand(command, service.args ?? [], service.env ?? {});
  if (!parsed.ok) return { ok: false, reason: `Service "${service.id}": ${parsed.reason}` };
  if (service.type === 'training' && parsed.invocation.kind !== 'script' && parsed.invocation.kind !== 'code' && parsed.invocation.kind !== 'module') {
    return { ok: false, reason: `Training service "${service.id}" runs a Python entry point (python train.py), not a server or an install.` };
  }
  if (fs) {
    const root = resolveFrom('/', service.root ?? '/');
    const dir = parsed.invocation.kind === 'serve' && parsed.invocation.server.appDir ? resolveFrom(root, parsed.invocation.server.appDir) : root;
    try {
      const { declined } = planRequirements(readProjectRequirements((path) => fs.readText(path), dir), new Set(provides.map(normalizeName)));
      if (declined.length) return { ok: false, reason: `Service "${service.id}" needs native-only packages: ${declined.map((entry) => entry.reason).join(' ')}` };
    } catch (error) {
      return { ok: false, reason: `Service "${service.id}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}

/** `host` is the runtime (`startPreviewRuntime()`'s, or a `ProcessHost` adapted): it runs Python commands in Python Workers. */
export function createPythonProvider(host: NodeServiceHost, options: PythonProviderOptions = {}): RuntimeProvider {
  const training = options.training;
  const { start } = createNodeProvider(host, {
    ...options,
    // A training service's process can be asked to checkpoint — when the page can reach it.
    controls: (service, process) => (service.type === 'training' && training?.canCheckpoint ? { checkpoint: async () => training.checkpoint(process.pid) } : options.controls?.(service, process)),
  });
  return {
    id: 'python',
    accepts: (service) => acceptsPythonService(service, options.fs, options.provides),
    start(service, context) {
      // Before the spawn: the process's start message is built from this page-side registration, never its env.
      if (service.type === 'training') training?.register(context.security);
      return start(service, context);
    },
  };
}
