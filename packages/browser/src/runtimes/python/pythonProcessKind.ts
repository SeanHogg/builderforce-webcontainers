/**
 * The Python runtime's process-kind policy for the process host
 * (node/processKinds.ts): Python commands — and scripts whose shebang names
 * Python (`./manage.py`) — run in a Python process Worker; a Python process's
 * start message carries the host's instructions (where Pyodide is served,
 * extensions, the session's `pip install`s); and `python-installed` reports are
 * accepted from Python processes only, and only when well formed (pipRecord.ts).
 *
 * The `pip install` record is per APPLICATION (W10): keyed by the page-side
 * `SecurityContext.applicationId` the host minted for the process — never by
 * anything the process sets (its env) — so one application neither sees nor
 * writes another's installs. The terminal and installs are the workspace's.
 * A call without a context is the workspace's.
 */
import { WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ProcessKindPolicy } from '../../node/processKinds.js';
import type { StartMessage, WorkerKind } from '../../node/protocol.js';
import type { PythonExtensionRef } from '../../node/protocol.js';
import { shebangRoute } from '../shebangRoute.js';
import { createPipRecord, validPipInstall, type PipRecord } from './pipRecord.js';
import { PYTHON_COMMAND_PATTERN, isPythonCommand } from './pythonCommand.js';

/** Host-only settings for Python processes: a program's environment can change neither. */
export interface PythonHostOptions {
  /** Where Pyodide is served (absolute, CORS-enabled; in relay mode, reachable from the preview origin). Default: the pinned jsDelivr build. */
  pyodideIndexURL?: string;
  /** Modules each Python Worker imports and installs before the program (pythonExtensions.ts). Absolute URLs, CORS-served. */
  extensions?: PythonExtensionRef[];
}

export interface PythonProcessKind extends ProcessKindPolicy {
  /** The workspace's `pip install` record (terminal, installs). */
  readonly pipRecord: PipRecord;
  /** The `pip install` record of the application `context` belongs to. */
  pipRecordFor(context: SecurityContext): PipRecord;
  /** What a `kind` process of `context`'s application starts with (its own record's installs). */
  startOptions(kind: WorkerKind, context?: SecurityContext): Pick<StartMessage, 'python' | 'php' | 'dotnet'>;
  /** A `python-installed` report from a process of `context`: kept in that application's record only. */
  receive(kind: WorkerKind, message: unknown, context?: SecurityContext): boolean;
  /** `python-installed` reports refused (not from a Python process, or malformed). */
  readonly rejectedReports: number;
}

export function createPythonProcessKind(options: PythonHostOptions = {}): PythonProcessKind {
  const records = new Map<string, PipRecord>();
  const pipRecordFor = ({ applicationId }: SecurityContext): PipRecord => {
    let record = records.get(applicationId);
    if (!record) records.set(applicationId, (record = createPipRecord()));
    return record;
  };
  let rejectedReports = 0;
  return {
    pipRecord: pipRecordFor(WORKSPACE_CONTEXT),
    pipRecordFor,
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
    startOptions(kind, context = WORKSPACE_CONTEXT) {
      if (kind !== 'python') return {};
      return { python: { indexURL: options.pyodideIndexURL, extensions: options.extensions, installs: pipRecordFor(context).read() } };
    },
    receive(kind, message, context = WORKSPACE_CONTEXT) {
      if ((message as { type?: unknown })?.type !== 'python-installed') return false;
      const install = kind === 'python' ? validPipInstall(message) : undefined;
      if (!install || !pipRecordFor(context).add(install)) rejectedReports++;
      return true;
    },
  };
}
