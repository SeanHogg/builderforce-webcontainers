/**
 * Names `./app` published stay importable after a move: `trackPhpWrites` and
 * `PhpEmscriptenFs` (2026.11.3) are deprecated aliases of the shared Emscripten
 * tracker and its FS type; `resolveFrom` is core's.
 */
import { describe, expect, it } from 'vitest';
import { resolveFrom as coreResolveFrom } from '@seanhogg/builderforce-webcontainers-core';
import { resolveFrom, trackPhpWrites, trackWrappedFsWrites, type PhpEmscriptenFs, type WrappableEmscriptenFs } from '../src/app.js';

describe('./app keeps its published names', () => {
  it('trackPhpWrites and PhpEmscriptenFs alias the shared tracker and FS type', () => {
    expect(trackPhpWrites).toBe(trackWrappedFsWrites);
    const sameType = (fs: PhpEmscriptenFs): WrappableEmscriptenFs => fs;
    expect(typeof sameType).toBe('function');
  });

  it('resolveFrom is core\'s', () => {
    expect(resolveFrom).toBe(coreResolveFrom);
    expect(resolveFrom('/api', '../web/./a.ts')).toBe('/web/a.ts');
    expect(resolveFrom('/api', '/abs//b')).toBe('/abs/b');
  });
});
