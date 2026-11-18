import { describe, expect, it } from 'vitest';
import { exec, kernelWith } from '../node/helpers.js';
import { ATTRIBUTION_OFF_MARKER } from '../../src/attribution.js';
import { completer } from '../../src/shell/program.js';
import type { Shell } from '../../src/shell/exec.js';
import type { Kernel } from '../../src/system/kernel.js';

const sh = (kernel: Kernel, script: string, cwd?: string) => exec(kernel, 'bfsh', ['-c', script], { cwd });

describe('hidden bfwc-badge command', () => {
  it('turns the preview badge off and on through the marker file, from any directory', async () => {
    const kernel = kernelWith({ 'app/index.html': '<body></body>' });
    expect(await sh(kernel, 'bfwc-badge')).toEqual({ output: 'on\n', code: 0 });

    const off = await sh(kernel, 'bfwc-badge off', '/app');
    expect(off.code).toBe(0);
    expect(off.output).toMatch(/reload/i);
    expect(kernel.fs.isFile(ATTRIBUTION_OFF_MARKER)).toBe(true);
    expect(await sh(kernel, 'bfwc-badge status', '/app')).toEqual({ output: 'off\n', code: 0 });
    // Idempotent.
    expect((await sh(kernel, 'bfwc-badge off')).code).toBe(0);

    const on = await sh(kernel, 'bfwc-badge on', '/app');
    expect(on.code).toBe(0);
    expect(on.output).toMatch(/reload/i);
    expect(kernel.fs.isFile(ATTRIBUTION_OFF_MARKER)).toBe(false);
    expect(kernel.fs.exists('/.bfwc')).toBe(false);
    expect(await sh(kernel, 'bfwc-badge status')).toEqual({ output: 'on\n', code: 0 });
  });

  it('turns it on when it was never off', async () => {
    const kernel = kernelWith();
    expect((await sh(kernel, 'bfwc-badge on')).code).toBe(0);
    expect(kernel.fs.isFile(ATTRIBUTION_OFF_MARKER)).toBe(false);
  });

  it('rejects anything else with usage and exit 2', async () => {
    const kernel = kernelWith();
    const bad = await sh(kernel, 'bfwc-badge maybe');
    expect(bad.code).toBe(2);
    expect(bad.output).toMatch(/^usage: bfwc-badge/);
    expect((await sh(kernel, 'bfwc-badge off on')).code).toBe(2);
    expect(kernel.fs.isFile(ATTRIBUTION_OFF_MARKER)).toBe(false);
  });

  it('is not revealed by help, type, which or tab completion', async () => {
    const kernel = kernelWith();
    const help = await sh(kernel, 'help');
    expect(help.code).toBe(0);
    expect(help.output).not.toMatch(/bfwc|badge/i);
    expect(await sh(kernel, 'type bfwc-badge')).toEqual({ output: 'type: bfwc-badge: not found\n', code: 1 });
    expect(await sh(kernel, 'which bfwc-badge')).toEqual({ output: 'bfwc-badge not found\n', code: 1 });

    const complete = completer({ system: { fs: kernel.fs }, cwd: '/' } as unknown as Shell);
    expect(complete('', 'bf')).not.toContain('bfwc-badge');
    expect(complete('', '').some((name) => /bfwc/.test(name))).toBe(false);
  });
});
