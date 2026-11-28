/**
 * Phase 3 — environment facts the residency manager reports.
 *
 * Facts, never gates: every probe resolves a conservative default when the
 * environment has no answer, and none of them throws.
 */

import { probeDeviceMemoryBytes } from '../shared/hardwareProbe.js';

/** RAM hint used when the environment reports none. */
export const DEFAULT_RAM_BYTES = 4 * 1024 * 1024 * 1024;

/** Probe a RAM hint. Fact, not a gate. 4 GiB when the environment has none. */
export function probeRamBytes(): number {
  return probeDeviceMemoryBytes() ?? DEFAULT_RAM_BYTES;
}

/**
 * Probe a browser-storage quota hint. Resolves 0 when the Storage API is
 * absent (Node tests, locked-down iframes). Never throws.
 */
export async function probeStorageQuotaBytes(): Promise<number> {
  const nav = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number }> } } }).navigator;
  try {
    const estimate = await nav?.storage?.estimate?.();
    return typeof estimate?.quota === 'number' && estimate.quota > 0 ? estimate.quota : 0;
  } catch {
    return 0;
  }
}
