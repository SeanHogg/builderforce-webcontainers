import { describe, expect, it } from 'vitest';
import { normalizePath } from '../../src/paths.js';

/** The slow path alone: what normalizePath computed before its already-normal shortcut. */
function reference(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return '/' + parts.join('/');
}

describe('normalizePath (already-normal shortcut)', () => {
  it('returns normal paths unchanged and normalises everything else exactly as before', () => {
    const cases = [
      '', '/', '//', 'a', 'a/b', '/a', '/a/', '/a//b', '/a/./b', '/a/../b', '/..', '/.', '/a/..', '/a/.',
      '/...', '/a/...', '/.hidden', '/a/.b', '/a/..b', '/a\\b', 'C:\\x\\y', './a', '../a', '/a/b/c.d.ts',
      '/node_modules/@scope/pkg/index.js', '/sp ace/ü', '/a/b/', '/a//', '///a', '/a\n/', '/\n/', '/a\n', '/a\r\n/b/',
    ];
    for (const path of cases) expect(normalizePath(path), JSON.stringify(path)).toBe(reference(path));
  });
});
