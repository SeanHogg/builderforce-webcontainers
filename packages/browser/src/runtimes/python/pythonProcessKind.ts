/**
 * The Python runtime's process-kind policy for the process host
 * (node/processKinds.ts): Python commands — and scripts whose shebang names
 * Python (`./manage.py`) — run in a Python process Worker; a Python process's
 * start message carries the host's instructions (where Pyodide is served,
 * extensions, the session's `pip install`s); and `python-installed` reports are
 * accepted from Python processes only, and only when well formed (pipRecord.ts).
 */
import type { ProcessKindPolicy } from '../../node/processKinds.js';
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
  /** The session's `pip install` record. */
  readonly pipRecord: PipRecord;
  /** `python-installed` reports refused (not from a Python process, or malformed). */
  readonly rejectedReports: number;
}

export function createPythonProcessKind(options: PythonHostOptions = {}): PythonProcessKind {
  const pipRecord = createPipRecord();
  let rejectedReports = 0;
  return {
    pipRecord,
    get rejectedReports() {
      return rejectedReports;
    },
    foreignCommands: PYTHON_COMMAND_PATTERN,
    route(command, args, { fs, cwd, env }) {
      if (isPythonCommand(command)) return { kind: 'python', command, args };
      // A script run by path: its shebang may name Python (`#!/usr/bin/env python3`).
      const script = shebangRoute(command, args, { fs, cwd, env }, isPythonCommand);
      return script ? { kind: 'python', ...script } : { kind: 'node', command, args };
    },
    startOptions(kind) {
      if (kind !== 'python') return {};
      return { python: { indexURL: options.pyodideIndexURL, extensions: options.extensions, installs: pipRecord.read() } };
    },
    receive(kind, message) {
      if ((message as { type?: unknown })?.type !== 'python-installed') return false;
      const install = kind === 'python' ? validPipInstall(message) : undefined;
      if (!install || !pipRecord.add(install)) rejectedReports++;
      return true;
    },
  };
}
