import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_MANIFEST_DEPRECATION, locateManifest, MANIFEST_MAX_BYTES, manifestWritePath } from '../../src/manifest/locate.js';

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

  it('regression: a .builderforce that is a FILE (ENOTDIR) or a manifest path that is a directory (EISDIR) is missing, and the root fallback is read', async () => {
    const asFile = root();
    writeFileSync(join(asFile, '.builderforce'), 'not a directory');
    writeFileSync(join(asFile, 'builderforce.json'), '{"version":1}');
    expect(await locateManifest(asFile)).toMatchObject({ source: 'legacy', text: '{"version":1}' });
    const asDir = root();
    mkdirSync(join(asDir, '.builderforce', 'builderforce.json'), { recursive: true });
    expect(await locateManifest(asDir)).toEqual({ path: manifestWritePath(asDir), text: null, source: 'missing' });
  });

  it('regression: a .builderforce linked outside the project is refused and never read', async () => {
    const project = root();
    const elsewhere = root();
    mkdirSync(join(elsewhere, 'secret'));
    writeFileSync(join(elsewhere, 'secret', 'builderforce.json'), '{"version":1,"name":"outside"}');
    symlinkSync(join(elsewhere, 'secret'), join(project, '.builderforce'), 'junction');
    writeFileSync(join(project, 'builderforce.json'), '{"version":1,"name":"root"}');
    const located = await locateManifest(project);
    expect(located).toEqual({ path: manifestWritePath(project), text: null, source: 'missing', outside: true });
  });

  it('a link that stays inside the project is read', async () => {
    const project = root();
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'config', 'builderforce.json'), '{"version":1}');
    symlinkSync(join(project, 'config'), join(project, '.builderforce'), 'junction');
    expect(await locateManifest(project)).toMatchObject({ source: 'file', text: '{"version":1}' });
  });

  it('a root manifest that is a link to a file outside the project is refused too', async () => {
    const project = root();
    const elsewhere = root();
    writeFileSync(join(elsewhere, 'builderforce.json'), '{"version":1}');
    try {
      symlinkSync(join(elsewhere, 'builderforce.json'), join(project, 'builderforce.json'), 'file');
    } catch {
      return; // file symlinks need a privilege on Windows: covered on POSIX CI
    }
    expect(await locateManifest(project)).toEqual({ path: join(project, 'builderforce.json'), text: null, source: 'missing', outside: true });
  });
});

describe('regression: a manifest that is there but cannot be read is reported, never skipped', () => {
  it('an oversized canonical manifest stops the search: the stale root file is not read in its place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bfwc-manifest-big-'));
    try {
      mkdirSync(join(dir, '.builderforce'));
      writeFileSync(join(dir, '.builderforce', 'builderforce.json'), ' '.repeat(MANIFEST_MAX_BYTES + 1));
      writeFileSync(join(dir, 'builderforce.json'), '{"version":1,"name":"stale"}');
      const located = await locateManifest(dir);
      expect(located).toMatchObject({ path: manifestWritePath(dir), text: null, source: 'missing' });
      expect(located.unreadable).toContain('bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
