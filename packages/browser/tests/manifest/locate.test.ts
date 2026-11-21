import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_MANIFEST_DEPRECATION, locateManifest, manifestWritePath } from '../../src/manifest/locate.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfwc-manifest-'));
  roots.push(dir);
  return dir;
}

describe('locateManifest', () => {
  it('reads .builderforce/builderforce.json and does not flag it', async () => {
    const dir = root();
    mkdirSync(join(dir, '.builderforce'));
    writeFileSync(join(dir, '.builderforce', 'builderforce.json'), '{"version":1}');
    writeFileSync(join(dir, 'builderforce.json'), '{"version":1,"name":"stale"}');
    const located = await locateManifest(dir);
    expect(located.source).toBe('file');
    expect(located.text).toBe('{"version":1}');
    expect(located.deprecation).toBeUndefined();
    expect(located.path).toBe(manifestWritePath(dir));
  });

  it('reads a root builderforce.json as legacy and never offers it as the write path', async () => {
    const dir = root();
    writeFileSync(join(dir, 'builderforce.json'), '{"version":1}');
    const located = await locateManifest(dir);
    expect(located.source).toBe('legacy');
    expect(located.deprecation).toBe(LEGACY_MANIFEST_DEPRECATION);
    expect(located.path).toBe(join(dir, 'builderforce.json'));
    expect(manifestWritePath(dir)).toBe(join(dir, '.builderforce', 'builderforce.json'));
  });

  it('reads a root bfwc.app.json as legacy', async () => {
    const dir = root();
    writeFileSync(join(dir, 'bfwc.app.json'), '{"version":1}');
    const located = await locateManifest(dir);
    expect(located.source).toBe('legacy');
    expect(located.text).toBe('{"version":1}');
  });

  it('names the canonical path when nothing is there', async () => {
    const dir = root();
    const located = await locateManifest(dir);
    expect(located).toEqual({ path: manifestWritePath(dir), text: null, source: 'missing' });
  });
});
