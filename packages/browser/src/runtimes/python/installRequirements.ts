/**
 * Installing a Python project's requirements with micropip: Pyodide-built
 * packages from Pyodide's own index, pure-Python wheels from PyPI (or the
 * project's `--index-url`/`PIP_INDEX_URL`). Packages that cannot work are
 * declined by name — the known ones before anything downloads, the rest when
 * micropip reports no usable wheel — and everything else is still installed: a
 * declined top-level requirement is dropped, a declined dependency of another
 * package is mocked (`micropip.add_mock_package`) so its dependents install.
 */
import type { PyodideLike } from './pyodideLoader.js';
import { noWheelReason, normalizeName, planRequirements, type DeclinedPackage, type Requirement } from './requirements.js';

export interface InstallReport {
  installed: string[];
  /** App servers the runtime provides; listed, never installed. */
  provided: string[];
  declined: DeclinedPackage[];
}

export interface InstallOptions {
  /** Package indexes, first wins (`pip install -i`, `PIP_INDEX_URL`). Default: PyPI. */
  indexUrls?: readonly string[];
  /** Progress lines. */
  log?: (line: string) => void;
  /** Normalized names a host extension already satisfies: never installed, never declined. */
  provided?: ReadonlySet<string>;
}

/** Names micropip reports it has no usable wheel for (`Can't find a pure Python 3 wheel for: 'a', 'b'`). */
export function packagesWithoutWheels(message: string): string[] {
  const names: string[] = [];
  for (const match of message.matchAll(/(?:pure Python 3 wheel|pure Python wheel|wheel compatible with Pyodide)[^:'"]*:?\s*((?:['"][^'"]+['"](?:,\s*)?)+)/gi)) {
    for (const quoted of match[1]!.matchAll(/['"]([^'"]+)['"]/g)) names.push(normalizeName(quoted[1]!.split(/[<>=!~;[ ]/)[0]!));
  }
  return [...new Set(names)];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function micropip(pyodide: PyodideLike, code: string, values: Record<string, unknown>): Promise<void> {
  const globals = pyodide.toPy(values);
  try {
    await pyodide.runPythonAsync(`import micropip\n${code}`, { globals });
  } finally {
    globals.destroy?.();
  }
}

/** Install `requirements`. Never throws for a declined package; throws for anything else micropip cannot do. */
export async function installRequirements(pyodide: PyodideLike, requirements: readonly Requirement[], options: InstallOptions = {}): Promise<InstallReport> {
  const plan = planRequirements(requirements, options.provided);
  const report: InstallReport = { installed: [], provided: plan.provided, declined: [...plan.declined] };
  let pending = plan.install;
  if (!pending.length) return report;
  const log = options.log ?? (() => undefined);
  await pyodide.loadPackage('micropip', { messageCallback: () => undefined, errorCallback: log });
  const indexUrls = options.indexUrls?.length ? [...options.indexUrls] : undefined;
  // Each failed attempt declines at least one more package, so this ends.
  for (;;) {
    try {
      await micropip(pyodide, 'await micropip.install(specs, index_urls=index_urls)', { specs: pending.map((requirement) => requirement.spec), index_urls: indexUrls });
      report.installed.push(...pending.map((requirement) => requirement.name));
      return report;
    } catch (error) {
      const missing = packagesWithoutWheels(errorText(error)).filter((name) => !report.declined.some((declined) => declined.name === name));
      if (!missing.length) throw error;
      for (const name of missing) report.declined.push({ name, reason: noWheelReason(name) });
      const topLevel = new Set(pending.filter((requirement) => missing.includes(requirement.name)).map((requirement) => requirement.name));
      const dependencies = missing.filter((name) => !topLevel.has(name));
      // A dependency is mocked so what needs it installs; importing it fails with Python's own error.
      for (const name of dependencies) await micropip(pyodide, 'micropip.add_mock_package(name, "0.0.0")', { name });
      pending = pending.filter((requirement) => !topLevel.has(requirement.name));
      if (!pending.length) return report;
    }
  }
}

/** The report as the lines `pip install` prints. */
export function describeInstall(report: InstallReport): string[] {
  const lines: string[] = [];
  if (report.installed.length) lines.push(`Successfully installed ${report.installed.join(' ')}`);
  if (report.provided.length) lines.push(`Provided by the runtime (not installed): ${report.provided.join(' ')}`);
  for (const { reason } of report.declined) lines.push(`Declined: ${reason}`);
  return lines;
}
