/**
 * A Python project's dependencies, as the Python runtime installs them with
 * micropip: read from `requirements.txt` (with `-r` includes) or
 * `pyproject.toml` (`[project] dependencies`, Poetry's table), and sorted into
 * what to install, what the runtime itself provides (the ASGI/WSGI servers it
 * replaces), and what it declines — packages known not to work in the browser,
 * each with a reason naming it. Pure: files are read through a callback.
 */
import { dirname, join, normalizePath } from '@seanhogg/builderforce-webcontainers-core';
import { tomlStringArray, tomlTable } from './tomlScan.js';

export interface Requirement {
  /** Normalized (PEP 503): lower case, runs of `-_.` as one `-`. */
  name: string;
  /** What micropip is given: the requirement as written, minus comments and per-line pip options. */
  spec: string;
}

export interface DeclinedPackage {
  name: string;
  reason: string;
}

export interface RequirementPlan {
  install: Requirement[];
  /** Served by the runtime itself, so never installed (uvicorn, gunicorn, …). */
  provided: string[];
  declined: DeclinedPackage[];
}

/** PEP 503 normalization. */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/g, '-');

const NO_WASM = 'has native code with no WebAssembly (Pyodide) build';
const USE_PG8000 = 'use pg8000 (pure Python) to reach Postgres.';

/**
 * Packages known not to work in the browser runtime — the fast path, before
 * anything downloads. Any other package micropip finds no pure-Python or
 * Pyodide wheel for is declined by name when it says so.
 */
export const NATIVE_ONLY_PACKAGES: Readonly<Record<string, string>> = {
  psycopg2: `${NO_WASM}; ${USE_PG8000}`,
  'psycopg2-binary': `${NO_WASM}; ${USE_PG8000}`,
  psycopg: `needs the native libpq client library; ${USE_PG8000}`,
  'psycopg-binary': `${NO_WASM}; ${USE_PG8000}`,
  'psycopg-c': `${NO_WASM}; ${USE_PG8000}`,
  asyncpg: `opens sockets through asyncio's native event loop, which the browser runtime cannot provide; ${USE_PG8000}`,
  mysqlclient: 'needs the native MySQL client library; use PyMySQL (pure Python).',
  pycurl: `${NO_WASM} (it links libcurl); use requests or httpx.`,
  psutil: `${NO_WASM} (it reads the operating system's process table).`,
  greenlet: `${NO_WASM} (it switches C stacks).`,
  gevent: `${NO_WASM} (it needs greenlet and libev).`,
  uvloop: `${NO_WASM}; the runtime drives asyncio itself.`,
  httptools: `${NO_WASM}; the runtime parses HTTP itself.`,
  watchfiles: `${NO_WASM}; the runtime reloads on file changes itself.`,
  grpcio: `${NO_WASM}.`,
  'grpcio-tools': `${NO_WASM}.`,
  pyzmq: `${NO_WASM} (it links libzmq).`,
  pymssql: `${NO_WASM} (it links FreeTDS).`,
  pyodbc: `${NO_WASM} (it links an ODBC driver manager).`,
  uwsgi: `${NO_WASM}; the runtime serves WSGI apps itself.`,
  'mod-wsgi': `${NO_WASM}; the runtime serves WSGI apps itself.`,
  torch: `${NO_WASM}; PyTorch training runs on the runtime's WebGPU torch module (PRD 31 phase 7) or in a container.`,
  torchvision: `${NO_WASM}.`,
  torchaudio: `${NO_WASM}.`,
  tensorflow: `${NO_WASM}.`,
  'tensorflow-cpu': `${NO_WASM}.`,
  jaxlib: `${NO_WASM}.`,
};

/** App servers the runtime replaces (it ships `uvicorn`/`gunicorn` stand-ins whose `run()` serves through it). */
export const RUNTIME_PROVIDED_PACKAGES: ReadonlySet<string> = new Set(['uvicorn', 'gunicorn', 'hypercorn', 'waitress', 'daphne', 'granian', 'fastapi-cli']);

/** The reason a package is declined up front, if it is known not to work in the browser runtime. */
export function nativeOnlyReason(name: string): string | undefined {
  const normalized = normalizeName(name);
  const reason = NATIVE_ONLY_PACKAGES[normalized];
  return reason && `"${normalized}" ${reason}`;
}

/** The reason for a package micropip found no usable wheel for. */
export const noWheelReason = (name: string) =>
  nativeOnlyReason(name) ?? `"${normalizeName(name)}" has no pure-Python or Pyodide wheel (a native-only package); it cannot be installed in the browser runtime.`;

/** Per-line pip options after a requirement (`--hash=…`, `--config-settings …`): everything from the first. */
const LINE_OPTIONS = /\s+--?[A-Za-z][\w-]*(?:[=\s][\s\S]*)?$/;

/** One requirement from a line or a PEP 508 string; undefined for blanks, comments and option lines. */
export function parseRequirement(line: string): Requirement | undefined {
  const text = line.replace(/(^|\s)#.*$/, '').replace(LINE_OPTIONS, '').trim();
  if (!text || text.startsWith('-')) return undefined;
  // A URL or wheel path is passed through as is; its name is the wheel's.
  if (/^[a-z+]+:\/\//i.test(text) || text.endsWith('.whl')) {
    const file = text.split('/').pop()!.split('#')[0]!;
    return { name: normalizeName(file.split('-')[0]!), spec: text };
  }
  const named = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text);
  if (!named) return undefined;
  // Environment markers (`; python_version < "3.8"`) are evaluated by micropip; keep them.
  return { name: normalizeName(named[1]!), spec: text };
}

/** Requirements of a `requirements.txt`, and the files it includes (`-r other.txt`; `-c` constraints are ignored). */
export function parseRequirementsTxt(text: string): { requirements: Requirement[]; includes: string[] } {
  const requirements: Requirement[] = [];
  const includes: string[] = [];
  // Backslash continuations join lines (hashes are often listed that way).
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const include = /^\s*(?:-r|--requirement)[\s=]+(\S+)/.exec(line);
    if (include) includes.push(include[1]!);
    const requirement = parseRequirement(line);
    if (requirement) requirements.push(requirement);
  }
  return { requirements, includes };
}

/** Requirements of a `pyproject.toml`: PEP 621 `[project] dependencies`, else Poetry's `[tool.poetry.dependencies]`. */
export function parsePyproject(text: string): Requirement[] {
  const project = tomlTable(text, 'project');
  const pep621 = project === undefined ? [] : tomlStringArray(project, 'dependencies');
  if (pep621.length) return pep621.map(parseRequirement).filter((req): req is Requirement => !!req);
  const poetry = tomlTable(text, 'tool.poetry.dependencies');
  if (poetry === undefined) return [];
  const out: Requirement[] = [];
  for (const line of poetry.split(/\r?\n/)) {
    const entry = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
    if (entry && normalizeName(entry[1]!) !== 'python') out.push({ name: normalizeName(entry[1]!), spec: entry[1]! });
  }
  return out;
}

/** `file` against the directory `dir` (an absolute `file` stays as it is), normalized. */
export const resolveFrom =(dir: string, file: string) => (file.startsWith('/') ? normalizePath(file) : join(dir, file));

/**
 * A requirements file (an absolute path) and everything it includes, each file
 * read once however it is spelled (`./a.txt`, `sub/../a.txt`).
 */
export function readRequirementFile(read: (path: string) => string | undefined, path: string, seen = new Set<string>()): Requirement[] {
  const file = normalizePath(path);
  if (seen.has(file)) return [];
  seen.add(file);
  const text = read(file);
  if (text === undefined) throw new Error(`Could not open requirements file: ${path}`);
  const { requirements, includes } = parseRequirementsTxt(text);
  return [...requirements, ...includes.flatMap((include) => readRequirementFile(read, resolveFrom(dirname(file), include), seen))];
}

/** The declared dependencies of the project in `dir` (absolute): `requirements.txt` first, else `pyproject.toml`; none when neither exists. */
export function readProjectRequirements(read: (path: string) => string | undefined, dir: string): Requirement[] {
  const requirementsTxt = join(dir, 'requirements.txt');
  if (read(requirementsTxt) !== undefined) return readRequirementFile(read, requirementsTxt);
  const pyproject = read(join(dir, 'pyproject.toml'));
  return pyproject === undefined ? [] : parsePyproject(pyproject);
}

/**
 * Sort requirements into install / provided / declined; duplicates keep their
 * first spec. `provided` (normalized names a host extension satisfies) win over
 * everything, the native-only list included.
 */
export function planRequirements(requirements: readonly Requirement[], provided: ReadonlySet<string> = new Set()): RequirementPlan {
  const plan: RequirementPlan = { install: [], provided: [], declined: [] };
  const seen = new Set<string>();
  for (const requirement of requirements) {
    if (seen.has(requirement.name)) continue;
    seen.add(requirement.name);
    const reason = nativeOnlyReason(requirement.name);
    if (provided.has(requirement.name) || RUNTIME_PROVIDED_PACKAGES.has(requirement.name)) plan.provided.push(requirement.name);
    else if (reason) plan.declined.push({ name: requirement.name, reason });
    else plan.install.push(requirement);
  }
  return plan;
}
