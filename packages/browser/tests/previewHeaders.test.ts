/**
 * The preview origins' headers (`previewHeaders.ts`, exported as `./preview-headers`)
 * — the ONE owner of these strings. Pinned here under the Builderforce API's profile
 * exactly as its `application/runtime/{previewOriginHeaders,workerCsp}.ts` serve them
 * today (2026.11), so the API can import this module instead, and under the local
 * launcher's profile.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECT_SOURCES, PREVIEW_DEFAULT_EGRESS, PREVIEW_WORKER_SCRIPTS, previewDocumentCsp, previewHeaders, relayCsp, serviceWorkerCsp, workerScriptCsp,
} from '../src/previewHeaders.js';

const REPORT_URL = 'https://api.builderforce.ai/api/runtime/csp-report';
const API = previewHeaders({
  embed: { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'cross-origin' },
  reporting: { group: 'bfwc-csp', endpoints: `bfwc-csp="${REPORT_URL}"` },
  scriptType: 'text/javascript',
  workerScriptCache: 'public, max-age=300',
});
const APP = ['https://builderforce.ai', 'https://www.builderforce.ai'];

const DEFAULT_EGRESS =
  'https://registry.npmjs.org https://cdn.jsdelivr.net https://data.jsdelivr.com https://pypi.org https://files.pythonhosted.org https://packagist.org/packages/ https://repo.packagist.org https://api.nuget.org https://globalcdn.nuget.org https://github.com https://api.github.com https://codeload.github.com https://raw.githubusercontent.com https://objects.githubusercontent.com';

describe('the preview header strings', () => {
  it('lists and defaults', () => {
    expect(DEFAULT_CONNECT_SOURCES.join(' ')).toBe(DEFAULT_EGRESS);
    expect(PREVIEW_DEFAULT_EGRESS).toEqual(['https://esm.sh']);
    expect(PREVIEW_WORKER_SCRIPTS).toEqual(['sw.js', 'process-worker.js', 'python-worker.js', 'php-worker.js', 'dotnet-worker.js', 'rust-worker.js']);
  });

  it('the CSPs, with and without reporting', () => {
    expect(serviceWorkerCsp()).toBe("default-src 'none'; connect-src 'self'");
    expect(relayCsp(APP)).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; worker-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://builderforce.ai https://www.builderforce.ai",
    );
    expect(workerScriptCsp(['https://api.example.com', 'https://registry.npmjs.org'], { group: 'bfwc-csp', endpoints: '' })).toBe(
      `default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${DEFAULT_EGRESS} https://api.example.com; worker-src 'self' blob:; connect-src ${DEFAULT_EGRESS} https://api.example.com; report-to bfwc-csp`,
    );
    expect(workerScriptCsp()).toBe(`default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${DEFAULT_EGRESS}; worker-src 'self' blob:; connect-src ${DEFAULT_EGRESS}`);
    expect(previewDocumentCsp({ host: 'preview.builderforce.ai', frameAncestors: APP })).toBe(
      "default-src 'self' https://esm.sh; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh; style-src 'self' 'unsafe-inline' blob: data: https://esm.sh; img-src 'self' data: blob: https://esm.sh; font-src 'self' data: https://esm.sh; media-src 'self' data: blob: https://esm.sh; connect-src 'self' ws://preview.builderforce.ai wss://preview.builderforce.ai blob: data: https://esm.sh; frame-src 'self' blob:; form-action 'self' https://esm.sh; worker-src 'self' blob:; frame-ancestors https://builderforce.ai https://www.builderforce.ai",
    );
  });
});

describe('the Builderforce API profile (what previewOriginHeaders.ts serves today)', () => {
  const EMBED = { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'cross-origin' };

  it('relay.html', () => {
    const headers = API.relay(APP);
    expect(headers).toEqual({
      ...EMBED,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': relayCsp(APP),
      'X-Content-Type-Options': 'nosniff',
      'Origin-Agent-Cluster': '?1',
      'Cache-Control': 'no-store',
    });
    expect(Object.keys(headers)).toEqual(['Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy', 'Content-Type', 'Content-Security-Policy', 'X-Content-Type-Options', 'Origin-Agent-Cluster', 'Cache-Control']);
  });

  it('sw.js', () => {
    expect(API.serviceWorker()).toEqual({ ...EMBED, 'Content-Type': 'text/javascript', 'Content-Security-Policy': "default-src 'none'; connect-src 'self'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  });

  it('a process Worker under a policy (its declared origins, then the own paths)', () => {
    const headers = API.workerScript(['https://api.example.com', 'https://preview.builderforce.ai/dotnet/']);
    expect(headers).toEqual({
      ...EMBED,
      'Content-Type': 'text/javascript',
      'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${DEFAULT_EGRESS} https://api.example.com https://preview.builderforce.ai/dotnet/; worker-src 'self' blob:; connect-src ${DEFAULT_EGRESS} https://api.example.com https://preview.builderforce.ai/dotnet/; report-to bfwc-csp`,
      'Reporting-Endpoints': `bfwc-csp="${REPORT_URL}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    });
    expect(Object.keys(headers)).toEqual(['Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy', 'Content-Type', 'Content-Security-Policy', 'Reporting-Endpoints', 'X-Content-Type-Options', 'Cache-Control']);
  });

  it('every other response, on its host (lowercased)', () => {
    const headers = API.document('Preview.Builderforce.AI', APP);
    expect(headers).toEqual({
      ...EMBED,
      'Content-Security-Policy': `${previewDocumentCsp({ host: 'preview.builderforce.ai', frameAncestors: APP })}; report-to bfwc-csp`,
      'Reporting-Endpoints': `bfwc-csp="${REPORT_URL}"`,
      'X-Content-Type-Options': 'nosniff',
      'Origin-Agent-Cluster': '?1',
    });
    expect(Object.keys(headers)).toEqual(['Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy', 'Content-Security-Policy', 'Reporting-Endpoints', 'X-Content-Type-Options', 'Origin-Agent-Cluster']);
  });
});

describe('the local launcher profile', () => {
  const LAUNCHER = previewHeaders({ scriptType: 'text/javascript; charset=utf-8', workerScriptCache: 'no-cache' });

  it('no embedding headers and no reporting; Worker scripts re-checked on every load', () => {
    expect(LAUNCHER.relay(['https://localhost:4000'])).not.toHaveProperty('Cross-Origin-Embedder-Policy');
    expect(LAUNCHER.serviceWorker()['Content-Type']).toBe('text/javascript; charset=utf-8');
    const worker = LAUNCHER.workerScript();
    expect(worker['Content-Security-Policy']).not.toContain('report-to');
    expect(worker).not.toHaveProperty('Reporting-Endpoints');
    expect(worker['Cache-Control']).toBe('no-cache');
    expect(LAUNCHER.document('k.localhost:4000', ['https://localhost:4000'])['Content-Security-Policy']).toBe(
      previewDocumentCsp({ host: 'k.localhost:4000', frameAncestors: ['https://localhost:4000'] }),
    );
  });
});
