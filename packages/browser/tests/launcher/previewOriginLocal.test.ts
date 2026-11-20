/**
 * The local launcher's origins under the preview-origin validator (`previewOrigin.ts`):
 * the launcher serves https with its own local CA, so its relay (`https://127.0.0.1:P`)
 * and per-application origins (`https://<key>.localhost:P`) pass the same https-only
 * rules as production — there is no plain-http exception, not even on loopback.
 */
import { describe, expect, it } from 'vitest';
import { PreviewShieldError, checkPreviewOrigins, previewOriginTemplate, validatePreviewOrigin } from '../../src/previewOrigin.js';

const PAGE = 'https://localhost:4000';
const KEY = '0123456789abcdef0123456789abcdef';

function reason(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewShieldError);
    return (error as PreviewShieldError).reason;
  }
}

describe('the launcher relay', () => {
  it('accepts the https relay on 127.0.0.1, distinct from the page', () => {
    expect(checkPreviewOrigins({ relayUrl: 'https://127.0.0.1:4000/__bfwc/relay.html' }, PAGE)).toBe('https://127.0.0.1:4000');
  });

  it('refuses any http relay — loopback included — and a relay on the page’s own origin', () => {
    for (const relayUrl of ['http://127.0.0.1:4000/__bfwc/relay.html', 'http://localhost:4001/__bfwc/relay.html', `http://${KEY}.localhost:4000/__bfwc/relay.html`, 'http://preview.example.com/__bfwc/relay.html']) {
      expect(reason(() => checkPreviewOrigins({ relayUrl }, PAGE)), relayUrl).toBe('ingress.preview_origin_invalid');
      expect(reason(() => checkPreviewOrigins({ relayUrl }, 'http://localhost:4000')), relayUrl).toBe('ingress.preview_origin_invalid');
    }
    expect(reason(() => checkPreviewOrigins({ relayUrl: 'https://localhost:4000/__bfwc/relay.html' }, PAGE))).toBe('ingress.same_origin_refused');
  });
});

describe('per-application origins on the launcher', () => {
  const taken = [PAGE, 'https://127.0.0.1:4000'];

  it('accepts https://<key>.localhost:<port> from the template', () => {
    const origin = previewOriginTemplate('https://{key}.localhost:4000')(KEY, { runtimeId: 'p', applicationId: 'a' });
    expect(validatePreviewOrigin(origin, 'a', taken)).toBe(`https://${KEY}.localhost:4000`);
  });

  it('refuses http (loopback included), the page’s and the relay’s origins, and non-bare origins', () => {
    for (const bad of [`http://${KEY}.localhost:4000`, 'http://localhost:4001', 'http://127.0.0.1:4001', PAGE, 'https://127.0.0.1:4000', `https://${KEY}.localhost:4000/x`, `ws://${KEY}.localhost:4000`]) {
      expect(reason(() => validatePreviewOrigin(bad, 'a', taken)), bad).toBe('ingress.preview_origin_invalid');
    }
  });
});
