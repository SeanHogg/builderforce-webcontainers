/**
 * What `pip install` added in this session, so it outlives the process that
 * ran it: every Python process is a fresh interpreter, and `pip install X &&
 * python app.py` must still find X. A Python process reports each successful
 * install (`python-installed`); the host keeps them as separate groups — specs
 * with the indexes they came from — and every Python process it starts replays
 * each group with only that group's indexes (the start message's
 * `python.installs`), never applying them to anything else.
 *
 * A report is data from code the project runs, so it is checked before it is
 * kept: the host accepts it only from a Python process (pythonProcessKind.ts),
 * and only in this shape — bounded lists of plain strings, indexes `http(s)` only.
 */
import type { PipInstall } from '../../node/protocol.js';

export type { PipInstall } from '../../node/protocol.js';

/** Caps on what one report, and the whole session, may hold. */
export const PIP_RECORD_LIMITS = { specsPerInstall: 64, specLength: 256, indexesPerInstall: 8, indexUrlLength: 2048, installs: 64 } as const;

const plainString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The install a `python-installed` report describes, if it is well formed; undefined otherwise. */
export function validPipInstall(report: unknown): PipInstall | undefined {
  if (typeof report !== 'object' || report === null) return undefined;
  const { specs, indexUrls } = report as { specs?: unknown; indexUrls?: unknown };
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > PIP_RECORD_LIMITS.specsPerInstall) return undefined;
  if (!Array.isArray(indexUrls) || indexUrls.length > PIP_RECORD_LIMITS.indexesPerInstall) return undefined;
  if (!specs.every((spec) => plainString(spec, PIP_RECORD_LIMITS.specLength))) return undefined;
  if (!indexUrls.every((url) => plainString(url, PIP_RECORD_LIMITS.indexUrlLength) && httpUrl(url))) return undefined;
  return { specs: [...specs], indexUrls: [...indexUrls] };
}

/** The session's record: one group per install, in order, identical installs kept once. */
export interface PipRecord {
  /** Keep `install` (already validated); false when the session holds the maximum. */
  add(install: PipInstall): boolean;
  read(): PipInstall[];
  clear(): void;
}

export function createPipRecord(): PipRecord {
  const installs: PipInstall[] = [];
  const key = (install: PipInstall) => JSON.stringify([install.specs, install.indexUrls]);
  return {
    add(install) {
      if (installs.some((kept) => key(kept) === key(install))) return true;
      if (installs.length >= PIP_RECORD_LIMITS.installs) return false;
      installs.push({ specs: [...install.specs], indexUrls: [...install.indexUrls] });
      return true;
    },
    read: () => installs.map((install) => ({ specs: [...install.specs], indexUrls: [...install.indexUrls] })),
    clear() {
      installs.length = 0;
    },
  };
}
