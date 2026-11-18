/**
 * Host-provided Python extensions: modules the host names (never a program —
 * the references travel in the start message, not the environment) that the
 * Python Worker imports and installs before each program. An extension's
 * factory runs INSIDE the Worker, so what it builds (a WebGPU device, an
 * engine) lives beside the interpreter; Builderforce's `@webdit/torch` bridge
 * is one. A factory returns:
 *
 * - `jsModules`: JS objects Python imports by name (`pyodide.registerJsModule`);
 * - `files` under `root`: Python sources (`torch/__init__.py`), with `root` put
 *   first on `sys.path`. `root` must be outside the project (`/project`), and
 *   every file must stay inside `root`: an extension never writes the project;
 * - `provides`: distribution names now satisfied (`torch`, `scikit-learn`) —
 *   requirement installs skip them (listed as provided, never declined, even
 *   when they are on the native-only list);
 * - `imports`: the top-level import names those provide (`sklearn`), so
 *   preloading a script's imports skips them. Default: each `provides` name
 *   with `-` as `_`.
 */
import { join, normalizePath } from '@seanhogg/builderforce-webcontainers-core';
import type { PythonExtensionRef } from '../../node/protocol.js';
import { PROJECT_MOUNT } from './pyodideFs.js';
import type { PyodideLike } from './pyodideLoader.js';
import { normalizeName } from './requirements.js';

export interface PythonExtension {
  jsModules?: Record<string, object>;
  files?: Record<string, string | Uint8Array>;
  /** Where `files` are written; outside the project. Default `/opt/bfwc-extensions/<n>`. */
  root?: string;
  /** Distribution names satisfied (requirement matching). */
  provides?: string[];
  /** Top-level import names satisfied (import preloading). */
  imports?: string[];
}

/** How the Worker imports an extension module (`import(url)` in a Worker; injectable in tests). */
export type ImportModule = (url: string) => Promise<Record<string, unknown>>;

export const importModule: ImportModule = (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

/** What the installed extensions satisfy: normalized distribution names and top-level import names. */
export interface ProvidedPackages {
  packages: ReadonlySet<string>;
  imports: ReadonlySet<string>;
}

export const NOTHING_PROVIDED: ProvidedPackages = { packages: new Set(), imports: new Set() };

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);

/** Where an extension's files go: its `root`, refused when it is (or holds) the project. */
function extensionRoot(ref: PythonExtensionRef, extension: PythonExtension, index: number): string {
  const root = normalizePath(extension.root ?? `/opt/bfwc-extensions/${index}`);
  if (inside(root, PROJECT_MOUNT) || inside(PROJECT_MOUNT, root)) throw new Error(`Python extension ${ref.moduleUrl}: root ${root} overlaps the project (${PROJECT_MOUNT}); extensions are installed outside it.`);
  return root;
}

/** `path` under `root`, refused when it escapes it (`../`, an absolute path elsewhere). */
function fileTarget(ref: PythonExtensionRef, root: string, path: string): string {
  const target = join(root, path);
  if (path.startsWith('/') || !inside(target, root) || target === root) throw new Error(`Python extension ${ref.moduleUrl}: file "${path}" is outside its root ${root}.`);
  return target;
}

/** Import each extension, run its factory, and install what it returns into `pyodide`. */
export async function installPythonExtensions(pyodide: PyodideLike, refs: readonly PythonExtensionRef[], load: ImportModule = importModule): Promise<ProvidedPackages> {
  const packages = new Set<string>();
  const imports = new Set<string>();
  for (const [index, ref] of refs.entries()) {
    const module = await load(ref.moduleUrl);
    const factory = module[ref.exportName];
    if (typeof factory !== 'function') throw new Error(`Python extension ${ref.moduleUrl} has no function export "${ref.exportName}".`);
    const extension = ((await (factory as () => unknown)()) ?? {}) as PythonExtension;
    const files = Object.entries(extension.files ?? {});
    // Every path is checked before anything is written or registered.
    const root = files.length ? extensionRoot(ref, extension, index) : undefined;
    const targets = files.map(([path, content]) => [fileTarget(ref, root!, path), content] as const);
    for (const [name, jsModule] of Object.entries(extension.jsModules ?? {})) pyodide.registerJsModule(name, jsModule);
    for (const [target, content] of targets) {
      pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')) || '/');
      pyodide.FS.writeFile(target, content);
    }
    if (root) pyodide.runPython(`import sys\nif ${JSON.stringify(root)} not in sys.path: sys.path.insert(0, ${JSON.stringify(root)})`);
    for (const name of extension.provides ?? []) packages.add(normalizeName(name));
    for (const name of extension.imports ?? (extension.provides ?? []).map((name) => name.replace(/-/g, '_'))) imports.add(name);
  }
  return { packages, imports };
}
