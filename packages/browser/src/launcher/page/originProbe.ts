/**
 * Before booting, the launcher page proves its preview origins are usable: the
 * relay (`https://127.0.0.1:<port>`) and the `*.localhost` application origins
 * must resolve to this machine and present a certificate the browser trusts. One
 * `fetch` of each origin's probe (`PREVIEW_PROBE_PATH`, readable by the page's
 * origin only) tells; a failure is a clear message instead of a runtime that dies
 * half-booted. (Chromium and Firefox resolve `*.localhost` themselves; Safari may not.)
 */
import { PREVIEW_PROBE_PATH, PROBE_KEY, type LaunchInfo } from '../protocol.js';

export type ProbeFetch = (input: string, init: { mode: 'cors'; cache: 'no-store'; credentials: 'omit' }) => Promise<{ ok: boolean; status: number }>;

/** The probe URLs: the relay's, then one application origin's (any key resolves the same way). */
export function probeUrlsOf(info: Pick<LaunchInfo, 'relayUrl' | 'previewOriginTemplate'>): string[] {
  return [new URL(PREVIEW_PROBE_PATH, info.relayUrl).href, `${info.previewOriginTemplate.split('{key}').join(PROBE_KEY)}${PREVIEW_PROBE_PATH}`];
}

export interface ProbeFailure {
  origin: string;
  /** What failed: the status, or the network error's message (a name that did not resolve, an untrusted certificate). */
  detail: string;
}

/** The first probe that failed, or null when every one answered. */
export async function probeOrigins(info: Pick<LaunchInfo, 'relayUrl' | 'previewOriginTemplate'>, fetchImpl: ProbeFetch): Promise<ProbeFailure | null> {
  for (const url of probeUrlsOf(info)) {
    const origin = new URL(url).origin;
    try {
      const response = await fetchImpl(url, { mode: 'cors', cache: 'no-store', credentials: 'omit' });
      if (!response.ok) return { origin, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { origin, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return null;
}
