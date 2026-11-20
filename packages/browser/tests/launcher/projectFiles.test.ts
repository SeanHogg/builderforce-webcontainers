/**
 * Reading project files without trusting they stayed put (`projectFiles.ts`): a file
 * whose path no longer resolves to what was checked is never sent, and a deleted
 * directory is one `deleted` change.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readContained, readProjectChange } from '../../src/launcher/server/projectFiles.js';
import { tempProject } from './launcherHelpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project(files: Record<string, string>) {
  const made = tempProject(files);
  cleanups.push(made.cleanup);
  return realpathSync(made.dir);
}

describe('readContained', () => {
  it('reads a file that is still where it was checked', async () => {
    const root = project({ 'a.txt': 'alpha' });
    const absolute = join(root, 'a.txt');
    const bytes = await readContained(root, absolute, { real: realpathSync(absolute) }, 1_000);
    expect(Buffer.from(bytes!).toString('utf8')).toBe('alpha');
  });

  it('drops a file whose path now resolves elsewhere (swapped between the check and the read)', async () => {
    const root = project({ 'a.txt': 'alpha', 'b.txt': 'bravo' });
    // Checked as b.txt, but the path read is a.txt: what the check saw is not what the path is now.
    expect(await readContained(root, join(root, 'a.txt'), { real: realpathSync(join(root, 'b.txt')) }, 1_000)).toBeNull();
  });

  it('drops a file that is gone, grew past the cap, or became a directory', async () => {
    const root = project({ 'a.txt': 'alpha', 'big.txt': 'x'.repeat(50) });
    const gone = join(root, 'a.txt');
    const real = realpathSync(gone);
    rmSync(gone);
    expect(await readContained(root, gone, { real }, 1_000)).toBeNull();
    expect(await readContained(root, join(root, 'big.txt'), { real: realpathSync(join(root, 'big.txt')) }, 10)).toBeNull();
    mkdirSync(join(root, 'dir'));
    expect(await readContained(root, join(root, 'dir'), { real: realpathSync(join(root, 'dir')) }, 1_000)).toBeNull();
  });
});

describe('readProjectChange', () => {
  it('a deleted directory is one deleted change for its path', async () => {
    const root = project({ 'web/src/a.ts': 'a' });
    rmSync(join(root, 'web'), { recursive: true, force: true });
    expect(await readProjectChange(root, 'web')).toEqual({ path: 'web', deleted: true });
  });

  it('a changed file is read through the same containment', async () => {
    const root = project({ 'a.txt': 'one' });
    writeFileSync(join(root, 'a.txt'), 'two');
    expect(await readProjectChange(root, 'a.txt')).toEqual({ path: 'a.txt', content: 'two' });
  });
});
