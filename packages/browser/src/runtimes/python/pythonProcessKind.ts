/**
 * The Python runtime's process-kind policy for the process host
 * (node/processKinds.ts): Python commands — and scripts whose shebang names
 * Python (`./manage.py`) — run in a Python process Worker; a Python process's
 * start message carries the host's instructions (where Pyodide is served,
 * extensions, the application's `pip install`s, and for a training service its
 * training control); `python-installed` reports are accepted from Python
 * processes only, and only when well formed (pipRecord.ts).
 *
 * The `pip install` record is per APPLICATION (W10): keyed by the page-side
 * `SecurityContext.applicationId` the host minted for the process — never by
 * anything the process sets (its env) — so one application neither sees nor
 * writes another's installs. The terminal and installs are the workspace's
 * (`WORKSPACE_CONTEXT`). A call without a usable context is refused.
 *
 * With `training` set, the root process the Python provider spawns for a
 * training service gets the training control, and its saves go to the page's
 * artifact store (trainingChannel.ts); a process's training state is dropped
 * when it exits (`exited`).
 */
import { WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ProcessKindPolicy } from '../../node/processKinds.js';
import type { PythonExtensionRef, PythonStartOptions, StartMessage, WorkerKind } from '../../node/protocol.js';
import { shebangRoute } from '../shebangRoute.js';
import { createPipRecord, validPipInstall, type PipRecord } from './pipRecord.js';
import { PYTHON_COMMAND_PATTERN, isPythonCommand } from './pythonCommand.js';
import { createTrainingChannel, type TrainingChannel, type TrainingOptions } from './trainingChannel.js';

/** Host-only settings for Python processes: a program's environment can change neither. */
export interface PythonHostOptions {
  /** Where Pyodide is served (absolute, CORS-enabled; in relay mode, reachable from the preview origin). Default: the pinned jsDelivr build. */
  pyodideIndexURL?: string;
  /** Modules each Python Worker imports and installs before the program (pythonExtensions.ts). Absolute URLs, CORS-served. */
  extensions?: PythonExtensionRef[];
  /** Training services: the host's project id and artifact store. Without it, the Python provider declines training services. */
  training?: TrainingOptions;
}

export interface PythonProcessKind extends ProcessKindPolicy {
  /** The workspace's `pip install` record (terminal, installs). */
  readonly pipRecord: PipRecord;
  /** The `pip install` record of the application `context` belongs to. */
  pipRecordFor(context: SecurityContext): PipRecord;
  /** `python-installed` reports refused (not from a Python process, malformed, or without a context). */
  readonly rejectedReports: number;
  /** Training services' page side (pass it to `createPythonProvider` as `training`); undefined without `options.training`. */
  readonly training?: TrainingChannel;
  /** The application was disposed: drop its `pip install` record and training state. */
  forgetApplication(applicationId: string): void;
}

const usable = (context: SecurityContext | undefined): context is SecurityContext => typeof context?.applicationId === 'string' && context.applicationId.length > 0;

export function createPythonProcessKind(options: PythonHostOptions = {}): PythonProcessKind {
  const records = new Map<string, PipRecord>();
  const pipRecordFor = ({ applicationId }: SecurityContext): PipRecord => {
    let record = records.get(applicationId);
    if (!record) records.set(applicationId, (record = createPipRecord()));
    return record;
  };
  const training = options.training ? createTrainingChannel(options.training) : undefined;
  let rejectedReports = 0;
  return {
    pipRecord: pipRecordFor(WORKSPACE_CONTEXT),
    pipRecordFor,
    training,
    get rejectedReports() {
      return rejectedReports;
    },
    foreignCommands: PYTHON_COMMAND_PATTERN,
    route(command, args, context) {
      if (isPythonCommand(command)) return { kind: 'python', command, args };
      // A script run by path: its shebang may name Python (`#!/usr/bin/env python3`).
      const script = shebangRoute(command, args, context, isPythonCommand);
      return script ? { kind: 'python', ...script } : { kind: 'node', command, args };
    },
    startOptions(kind: WorkerKind, context: SecurityContext): Pick<StartMessage, 'python' | 'php' | 'dotnet'> {
      if (kind !== 'python') return {};
      const python: PythonStartOptions = {
        indexURL: options.pyodideIndexURL,
        extensions: options.extensions,
        installs: usable(context) ? (records.get(context.applicationId)?.read() ?? []) : [],
      };
      const trainingOptions = usable(context) ? training?.startOptions(context) : undefined;
      if (trainingOptions) python.training = trainingOptions;
      return { python };
    },
    receive(kind: WorkerKind, message: unknown, context: SecurityContext) {
      if (training?.receive(message, kind === 'python' && usable(context) ? context : undefined)) return true;
      if ((message as { type?: unknown })?.type !== 'python-installed') return false;
      const install = kind === 'python' && usable(context) ? validPipInstall(message) : undefined;
      if (!install || !pipRecordFor(context).add(install)) rejectedReports++;
      return true;
    },
    exited(pid) {
      training?.exited(pid);
    },
    forgetApplication(applicationId) {
      if (applicationId !== WORKSPACE_CONTEXT.applicationId) records.delete(applicationId);
      training?.forgetApplication(applicationId);
    },
  };
}
