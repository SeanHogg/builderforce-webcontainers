/**
 * A local stand-in for Packagist's package API (`/packages/<name>.json`)
 * serving zip dists built here from in-memory fixtures, so `composer install`
 * in the PHP runtime resolves, downloads and autoloads without the network.
 * Point `php.composer.repositoryUrl` at `url`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VirtualFileSystem, exportZip } from '@seanhogg/builderforce-webcontainers-core';

export interface FixtureVersion {
  version: string;
  require?: Record<string, string>;
  autoload?: Record<string, unknown>;
  files: Record<string, string>;
}

export interface FakePackagist {
  /** The `repositoryUrl` template (`…/packages/{name}.json`). */
  url: string;
  /** Every path requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakePackagist(fixtures: Record<string, FixtureVersion[]>): Promise<FakePackagist> {
  const requests: string[] = [];
  let base = '';
  const zips = new Map<string, Uint8Array>();
  for (const [name, versions] of Object.entries(fixtures)) {
    for (const fixture of versions) {
      const fs = new VirtualFileSystem();
      const top = `${name.replace('/', '-')}-${fixture.version}`;
      const files: Record<string, string> = { ...fixture.files, 'composer.json': JSON.stringify({ name, autoload: fixture.autoload }) };
      fs.writeTree(Object.fromEntries(Object.entries(files).map(([path, content]) => [`${top}/${path}`, content])));
      zips.set(`/dist/${top}.zip`, exportZip(fs));
    }
  }
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    requests.push(path);
    const meta = /^\/packages\/(.+)\.json$/.exec(path);
    const versions = meta && fixtures[meta[1]!];
    if (versions) {
      const entries = versions.map((fixture) => [fixture.version, { name: meta![1], version: fixture.version, require: fixture.require ?? {}, autoload: fixture.autoload ?? {}, type: 'library', dist: { type: 'zip', url: `${base}/dist/${meta![1]!.replace('/', '-')}-${fixture.version}.zip`, reference: `ref-${fixture.version}` } }]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ package: { name: meta[1], versions: Object.fromEntries(entries) } }));
      return;
    }
    const zip = zips.get(path);
    res.writeHead(zip ? 200 : 404, { 'content-type': zip ? 'application/zip' : 'text/plain' });
    res.end(zip ? Buffer.from(zip) : 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${base}/packages/{name}.json`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
