/**
 * An offline package index for the Python runtime's tests: pure-Python wheels
 * built here (zipped with the core's `exportZip`), or vendored real ones
 * (tests/fixtures/wheels: pg8000 and its pure dependencies), served from a
 * local HTTP server speaking PyPI's JSON simple API, so micropip installs — and
 * declines — without the network. A package can also be listed with only a
 * native wheel (a CPython/Windows tag), which micropip must refuse.
 *
 * Packages micropip takes from Pyodide's own lock file (micropip itself,
 * python-dateutil, six) are vendored in tests/fixtures/pyodide-packages and
 * seeded into the Pyodide package cache (python-helpers.ts), so those load
 * offline too.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualFileSystem, exportZip } from '@seanhogg/builderforce-webcontainers-core';

export interface FixturePackage {
  name: string;
  version: string;
  /** Module files, relative to site-packages (`fixturepkg/__init__.py`). Absent (and no `wheel`): the package only has a native wheel. */
  files?: Record<string, string>;
  /** A vendored wheel file, served as is. */
  wheel?: string;
  requires?: string[];
  /** Extras the package declares (`Provides-Extra`). */
  extras?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const VENDORED_WHEELS = join(here, 'fixtures', 'wheels');
export const VENDORED_PYODIDE_PACKAGES = join(here, 'fixtures', 'pyodide-packages');

function wheelName(pkg: FixturePackage): string {
  if (pkg.wheel) return basename(pkg.wheel);
  return pkg.files ? `${pkg.name.replace(/-/g, '_')}-${pkg.version}-py3-none-any.whl` : `${pkg.name.replace(/-/g, '_')}-${pkg.version}-cp312-cp312-win_amd64.whl`;
}

export function buildWheel(pkg: FixturePackage): Uint8Array {
  if (pkg.wheel) return new Uint8Array(readFileSync(pkg.wheel));
  const fs = new VirtualFileSystem();
  const distInfo = `${pkg.name.replace(/-/g, '_')}-${pkg.version}.dist-info`;
  fs.writeTree(pkg.files ?? {});
  fs.writeTree({
    [`${distInfo}/METADATA`]: [`Metadata-Version: 2.1`, `Name: ${pkg.name}`, `Version: ${pkg.version}`, ...(pkg.extras ?? []).map((extra) => `Provides-Extra: ${extra}`), ...(pkg.requires ?? []).map((req) => `Requires-Dist: ${req}`), ''].join('\n'),
    [`${distInfo}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: bfwc-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    [`${distInfo}/top_level.txt`]: `${pkg.name.replace(/-/g, '_')}\n`,
    [`${distInfo}/RECORD`]: '',
  });
  return exportZip(fs);
}

export interface FakeIndex {
  /** The simple index URL (`pip install -i`, `PIP_INDEX_URL`). */
  url: string;
  /** Requests served, for assertions (`/simple/x/`, `/files/…`). */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeIndex(packages: readonly FixturePackage[]): Promise<FakeIndex> {
  const wheels = new Map(packages.filter((pkg) => pkg.files || pkg.wheel).map((pkg) => [wheelName(pkg), buildWheel(pkg)]));
  const requests: string[] = [];
  let base = '';
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/\/{2,}/g, '/');
    requests.push(path);
    const project = /^\/simple\/([^/]+)\/?$/.exec(path);
    const pkg = project && packages.find((candidate) => candidate.name === project[1]!.toLowerCase().replace(/[-_.]+/g, '-'));
    if (pkg) {
      response.writeHead(200, { 'content-type': 'application/vnd.pypi.simple.v1+json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ meta: { 'api-version': '1.0' }, name: pkg.name, files: [{ filename: wheelName(pkg), url: `${base}/files/${wheelName(pkg)}`, hashes: {} }] }));
      return;
    }
    const wheel = path.startsWith('/files/') ? wheels.get(path.slice('/files/'.length)) : undefined;
    if (wheel) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' });
      response.end(Buffer.from(wheel));
      return;
    }
    response.writeHead(404, { 'access-control-allow-origin': '*' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${base}/simple`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A pure package with no dependencies, one that needs a native-only package, and pg8000 with its pure dependencies (vendored). */
export const FIXTURES: readonly FixturePackage[] = [
  { name: 'fixturepkg', version: '1.0.0', files: { 'fixturepkg/__init__.py': 'VALUE = "fixture ok"\n' }, extras: ['speed'] },
  { name: 'needs-native', version: '1.0.0', files: { 'needs_native/__init__.py': 'VALUE = "installed without its native dependency"\n' }, requires: ['nativedep'] },
  { name: 'nativedep', version: '1.0.0' },
  { name: 'pg8000', version: '1.31.6', wheel: join(VENDORED_WHEELS, 'pg8000-1.31.6-py3-none-any.whl') },
  { name: 'scramp', version: '1.5.0', wheel: join(VENDORED_WHEELS, 'scramp-1.5.0-py3-none-any.whl') },
  { name: 'asn1crypto', version: '1.5.1', wheel: join(VENDORED_WHEELS, 'asn1crypto-1.5.1-py2.py3-none-any.whl') },
];
