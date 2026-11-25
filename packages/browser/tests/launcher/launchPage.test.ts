import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLaunchPageError, validateLaunchPage } from '../../src/launcher/server/launchPage.js';
import { buildLaunchInfo } from '../../src/launcher/server/launchInfo.js';
import type { LauncherHosts } from '../../src/launcher/server/hosts.js';
import { tempProject } from './launcherHelpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project(files: Record<string, string>): string {
  const made = tempProject(files);
  cleanups.push(made.cleanup);
  return realpathSync(made.dir);
}

describe('validateLaunchPage', () => {
  const codeOf = async (root: string, page: string) => validateLaunchPage(root, page).then(() => 'ok', (error: unknown) => (isLaunchPageError(error) ? error.code : 'other'));

  it('accepts an existing top-level .html or .htm file', async () => {
    const root = project({ 'mockup.html': '<p>a</p>', 'old.HTM': '<p>b</p>' });
    await expect(validateLaunchPage(root, '/mockup.html')).resolves.toBe('/mockup.html');
    await expect(validateLaunchPage(root, '/old.HTM')).resolves.toBe('/old.HTM');
  });

  it('refuses a path that is not project-relative, nested, or climbs out of the project, with a code', async () => {
    const root = project({ 'a.html': '', 'site/deep.html': '' });
    expect(await codeOf(root, 'a.html')).toBe('not-relative');
    expect(await codeOf(root, '\\a.html')).toBe('not-relative');
    expect(await codeOf(root, '/../a.html')).toBe('not-top-level');
    expect(await codeOf(root, '/site/../a.html')).toBe('not-top-level');
    expect(await codeOf(root, '/site/deep.html')).toBe('not-top-level');
    expect(await codeOf(root, '/')).toBe('not-top-level');
  });

  it('refuses a missing file, a directory, and a file that is not HTML, with a code', async () => {
    const root = project({ 'notes.txt': 'x' });
    mkdirSync(join(root, 'dir.html'));
    expect(await codeOf(root, '/gone.html')).toBe('missing');
    expect(await codeOf(root, '/dir.html')).toBe('directory');
    expect(await codeOf(root, '/notes.txt')).toBe('not-html');
  });

  it('refuses a link that resolves outside the project', async () => {
    const root = project({});
    const outside = project({ 'secret.html': '<p>no</p>' });
    try {
      symlinkSync(join(outside, 'secret.html'), join(root, 'link.html'));
    } catch {
      return; // links need a privilege on some platforms: nothing to test there
    }
    expect(await codeOf(root, '/link.html')).toBe('outside');
  });
});

describe('buildLaunchInfo page', () => {
  const hosts = { pageOrigin: 'https://localhost:9', relayOrigin: 'https://127.0.0.1:9', appOriginTemplate: 'https://{key}.localhost:9' } as LauncherHosts;

  it('carries the page, and leaves it out for a whole project', async () => {
    const root = project({ 'a.html': '' });
    const dotnet = { dir: null, reason: 'none' };
    expect(await buildLaunchInfo({ root, projectId: 'p1', hosts, dotnet, page: '/a.html' })).toMatchObject({ page: '/a.html' });
    expect(await buildLaunchInfo({ root, projectId: 'p1', hosts, dotnet })).not.toHaveProperty('page');
  });
});
