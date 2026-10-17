import { describe, expect, it, vi } from 'vitest';
import { VirtualFileSystem, createStyleImportHost, type DevServer, type PreviewUpdate } from '@seanhogg/builderforce-webcontainers-core';
import { createCdnStyleCompilers } from '../src/styleCompilers.js';
import { UPDATE_DEBOUNCE_MS, watchForPreviewUpdates } from '../src/previewUpdates.js';

describe('createCdnStyleCompilers', () => {
  // Stand-ins with each package's shape: Sass as an ES namespace, Less as a CommonJS default.
  const sassNamespace = { compileStringAsync: async (source: string) => ({ css: `/*sass*/${source}`, loadedUrls: [] }) };
  const lessCommonJs = { default: { render: async (source: string) => ({ css: `/*less*/${source}`, imports: [] }), FileManager: class {} } };

  it('loads each compiler once, pinned to the project range, and unwraps either module shape', async () => {
    const loaded: string[] = [];
    const importModule = async (url: string) => {
      loaded.push(url);
      return url.includes('less') ? lessCommonJs : sassNamespace;
    };
    const compilers = createCdnStyleCompilers({ importModule });
    const imports = createStyleImportHost({ fs: new VirtualFileSystem(), dependencies: {} });
    const sass = await compilers('scss', { sass: '^1.80.0' });
    await compilers('sass', { sass: '^1.80.0' });
    expect((await sass.compile('a{}', { path: '/a.scss', language: 'scss', imports })).css).toBe('/*sass*/a{}');
    const less = await compilers('less', { less: '^4.2.0' });
    expect((await less.compile('b{}', { path: '/b.less', language: 'less', imports })).css).toBe('/*less*/b{}');
    expect(loaded).toEqual(['https://esm.sh/sass@^1.80.0', 'https://esm.sh/less@^4.2.0']);
  });

  it('falls back to a default range and retries a failed download', async () => {
    let attempts = 0;
    const compilers = createCdnStyleCompilers({
      importModule: async () => {
        if (++attempts === 1) throw new Error('offline');
        return sassNamespace;
      },
    });
    await expect(compilers('scss', {})).rejects.toThrow('offline');
    await expect(compilers('scss', {})).resolves.toBeDefined();
  });
});

describe('watchForPreviewUpdates', () => {
  it('plans one update per burst of edits and sends it', () => {
    vi.useFakeTimers();
    try {
      const fs = new VirtualFileSystem();
      const bursts: number[] = [];
      const server = { planUpdate: (changes: readonly unknown[]) => (bursts.push(changes.length), { type: 'reload' }) } as unknown as DevServer;
      const sent: PreviewUpdate[] = [];
      const stop = watchForPreviewUpdates(fs, server, (update) => sent.push(update));
      fs.writeFile('/a.ts', '1');
      fs.writeFile('/b.ts', '2');
      vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
      expect(bursts).toEqual([2]);
      expect(sent).toEqual([{ type: 'reload' }]);
      stop();
      fs.writeFile('/c.ts', '3');
      vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
      expect(bursts).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing when the plan says nothing the preview shows changed', () => {
    vi.useFakeTimers();
    try {
      const fs = new VirtualFileSystem();
      const server = { planUpdate: () => undefined } as unknown as DevServer;
      const send = vi.fn();
      watchForPreviewUpdates(fs, server, send);
      fs.writeFile('/README.md', 'x');
      vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
