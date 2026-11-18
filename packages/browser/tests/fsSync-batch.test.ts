/** FsSync applies a process's journal op by op: one op that fails (EISDIR) neither loses the rest of the batch nor escapes to `onmessage`. */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { FsSync } from '../src/node/fsSync.js';

describe('FsSync batch application', () => {
  it('applies the ops after one that throws, and does not throw itself', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/dir');
    const sync = new FsSync<string>(fs, { send: () => undefined });
    sync.add('proc');
    expect(() =>
      sync.applyFrom('proc', [
        { op: 'write', path: '/before.txt', content: 'a' },
        { op: 'write', path: '/dir', content: 'cannot write over a directory' },
        { op: 'write', path: '/after.txt', content: 'b' },
      ]),
    ).not.toThrow();
    expect(fs.readFile('/before.txt')).toBe('a');
    expect(fs.readFile('/after.txt')).toBe('b');
  });
});
