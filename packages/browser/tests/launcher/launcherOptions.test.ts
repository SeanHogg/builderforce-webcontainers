/** The launcher integrator options `frameAncestors` and `ignoredDirs`. */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFrameAncestors, validateFrameAncestors } from '../../src/launcher/server/frameAncestors.js';
import { isExcludedPath, readProjectTree, resolveExcludedDirectories } from '../../src/launcher/server/projectFiles.js';
import { tempProject } from './launcherHelpers.js';

const PAGE = 'https://localhost:4000';

describe('resolveFrameAncestors', () => {
  it('puts the page origin first and accepts https and vscode-webview origins', () => {
    expect(resolveFrameAncestors(PAGE, ['https://builderforce.ai', 'vscode-webview://abc-123'])).toEqual([PAGE, 'https://builderforce.ai', 'vscode-webview://abc-123']);
  });

  it('de-duplicates, including the page origin itself', () => {
    expect(resolveFrameAncestors(PAGE, ['https://a.example', 'https://a.example', PAGE])).toEqual([PAGE, 'https://a.example']);
  });

  it('defaults to the page origin alone', () => {
    expect(resolveFrameAncestors(PAGE)).toEqual([PAGE]);
  });

  it('refuses a wildcard, http, a path, a bare host and other schemes', () => {
    for (const bad of ['*', 'https://*.example', 'http://a.example', 'https://a.example/path', 'a.example', 'file://x', 'https://a.example/']) {
      expect(() => validateFrameAncestors([bad]), bad).toThrow(/frameAncestors/);
    }
  });
});

describe('ignoredDirs', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('leaves a named directory out of the tree, beside the built-in exclusions', async () => {
    const made = tempProject({ 'src/a.ts': 'a', 'generated/b.ts': 'b', 'node_modules/c.js': 'c' });
    cleanups.push(made.cleanup);
    const root = realpathSync(made.dir);
    mkdirSync(join(root, 'nested/generated'), { recursive: true });
    writeFileSync(join(root, 'nested/generated/d.ts'), 'd');
    const tree = await readProjectTree(root, undefined, resolveExcludedDirectories(['generated']));
    expect(Object.keys(tree.files).sort()).toEqual(['src/a.ts']);
    expect(Object.keys((await readProjectTree(root)).files).sort()).toEqual(['generated/b.ts', 'nested/generated/d.ts', 'src/a.ts']);
  });

  it('applies to change paths too', () => {
    const excluded = resolveExcludedDirectories(['generated']);
    expect(isExcludedPath('a/generated/x.ts', excluded)).toBe(true);
    expect(isExcludedPath('a/other/x.ts', excluded)).toBe(false);
    expect(isExcludedPath('node_modules/x.js', excluded)).toBe(true);
  });

  it('refuses an entry that is not a single directory name', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x']) {
      expect(() => resolveExcludedDirectories([bad]), JSON.stringify(bad)).toThrow(/ignoredDirs/);
    }
  });
});
