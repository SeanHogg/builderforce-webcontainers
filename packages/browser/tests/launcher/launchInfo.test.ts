import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_MANIFEST_DEPRECATION, manifestWritePath } from '../../src/manifest/locate.js';
import { buildLaunchInfo } from '../../src/launcher/server/launchInfo.js';
import type { LauncherHosts } from '../../src/launcher/server/hosts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hosts = {
  pageOrigin: 'https://localhost:9',
  relayOrigin: 'https://127.0.0.1:9',
  appOriginTemplate: 'https://{key}.localhost:9',
} as LauncherHosts;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfwc-launch-info-'));
  roots.push(dir);
  return dir;
}

describe('buildLaunchInfo manifest source', () => {
  it('reads a root manifest as legacy and still names the canonical write path when missing', async () => {
    const dir = root();
    writeFileSync(join(dir, 'builderforce.json'), '{"version":1}');
    const legacy = await buildLaunchInfo({ root: dir, projectId: 'p1', hosts, dotnet: { dir: null, reason: 'none' } });
    expect(legacy.manifestSource).toBe('legacy');
    expect(legacy.deprecation).toBe(LEGACY_MANIFEST_DEPRECATION);
    expect(legacy.manifestPath).toBe(join(dir, 'builderforce.json'));

    const empty = root();
    const missing = await buildLaunchInfo({ root: empty, projectId: 'p1', hosts, dotnet: { dir: null, reason: 'none' } });
    expect(missing.manifestSource).toBe('missing');
    expect(missing.manifestPath).toBe(manifestWritePath(empty));
  });

  it('an override does not become the write path', async () => {
    const dir = root();
    mkdirSync(join(dir, '.builderforce'));
    const info = await buildLaunchInfo({
      root: dir,
      projectId: 'p1',
      hosts,
      manifestText: '{"version":1}',
      dotnet: { dir: null, reason: 'none' },
    });
    expect(info.manifestSource).toBe('override');
    expect(info.manifestPath).toBe(manifestWritePath(dir));
  });
});
