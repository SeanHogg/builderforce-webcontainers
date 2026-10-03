import { expect } from 'vitest';
import { gzipSync } from 'fflate';
import { tar } from '../../src/installer/tar.js';
import type { FetchLike, PackageManifest, Packument } from '../../src/installer/registry.js';

export interface FixtureVersion {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  hasInstallScript?: boolean;
  /** Extra files besides package.json (paths relative to the package root). */
  files?: Record<string, string>;
  /** Fields only in the tarball's package.json. */
  pkg?: Record<string, unknown>;
}

export interface FixturePackage {
  versions: Record<string, FixtureVersion>;
  tags?: Record<string, string>;
}

export const REGISTRY = 'https://registry.test';

async function sri(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes as unknown as ArrayBuffer));
  return 'sha512-' + btoa(String.fromCharCode(...digest));
}

export interface FakeRegistry {
  fetch: FetchLike;
  /** Every URL requested, in order. */
  requests: string[];
  packumentRequests(): string[];
  tarballRequests(): string[];
  /** Replace a tarball's bytes after publishing (integrity test). */
  corrupt(name: string, version: string): void;
}

export async function fakeRegistry(packages: Record<string, FixturePackage>): Promise<FakeRegistry> {
  const packuments = new Map<string, Packument>();
  const tarballs = new Map<string, Uint8Array>();
  for (const [name, fixture] of Object.entries(packages)) {
    const versions: Record<string, PackageManifest> = {};
    for (const [version, v] of Object.entries(fixture.versions)) {
      const pkgJson = { name, version, dependencies: v.dependencies, optionalDependencies: v.optionalDependencies, peerDependencies: v.peerDependencies, bin: v.bin, ...v.pkg };
      const files: Record<string, string> = { 'package/package.json': JSON.stringify(pkgJson) };
      for (const [path, contents] of Object.entries(v.files ?? { 'index.js': `module.exports = ${JSON.stringify(`${name}@${version}`)};` })) {
        files[`package/${path}`] = contents;
      }
      const tgz = gzipSync(tar(files));
      const url = `${REGISTRY}/${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`;
      tarballs.set(url, tgz);
      versions[version] = {
        name,
        version,
        dependencies: v.dependencies,
        optionalDependencies: v.optionalDependencies,
        peerDependencies: v.peerDependencies,
        bin: v.bin,
        os: v.os,
        cpu: v.cpu,
        hasInstallScript: v.hasInstallScript,
        dist: { tarball: url, integrity: await sri(tgz) },
      };
    }
    const latest = Object.keys(fixture.versions).at(-1)!;
    packuments.set(name, { name, 'dist-tags': { latest, ...fixture.tags }, versions });
  }

  const requests: string[] = [];
  const encoder = new TextEncoder();
  const respond = (status: number, body: Uint8Array) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
  });
  const fetch: FetchLike = async (url, init) => {
    requests.push(url);
    if (url.endsWith('.tgz')) {
      const body = tarballs.get(url);
      return body ? respond(200, body) : respond(404, new Uint8Array());
    }
    expect(init?.headers?.accept).toContain('application/vnd.npm.install-v1+json');
    const name = decodeURIComponent(url.slice(REGISTRY.length + 1));
    const doc = packuments.get(name);
    return doc ? respond(200, encoder.encode(JSON.stringify(doc))) : respond(404, encoder.encode('{}'));
  };

  return {
    fetch,
    requests,
    packumentRequests: () => requests.filter((u) => !u.endsWith('.tgz')),
    tarballRequests: () => requests.filter((u) => u.endsWith('.tgz')),
    corrupt(name, version) {
      const url = packuments.get(name)!.versions[version]!.dist.tarball;
      tarballs.set(url, gzipSync(tar({ 'package/package.json': '{"name":"evil"}' })));
    },
  };
}
