import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewShieldError,
  checkPreviewOrigins,
  previewOriginKey,
  previewOriginTemplate,
  resetSharedOriginWarning,
  validatePreviewOrigin,
  type ShieldEvent,
} from '../src/previewOrigin.js';

const PAGE = 'https://app.example.com';
const RELAY = 'https://preview.example.com/__bfwc/relay.html';

function refusal(run: () => unknown): PreviewShieldError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewShieldError);
    return error as PreviewShieldError;
  }
  throw new Error('expected a refusal');
}

describe('control 10: same-origin previews are refused at boot', () => {
  beforeEach(() => resetSharedOriginWarning());
  afterEach(() => vi.restoreAllMocks());

  it('refuses same-origin mode with a typed reason unless opted out by name', () => {
    const error = refusal(() => checkPreviewOrigins({ serviceWorkerUrl: '/__bfwc/sw.js' }, PAGE));
    expect(error.reason).toBe('ingress.same_origin_refused');
    expect(error.code).toBe('EBFWC_SHIELD');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(checkPreviewOrigins({ serviceWorkerUrl: '/__bfwc/sw.js', unprotectedSameOrigin: true }, PAGE)).toBeUndefined();
  });

  it("refuses a relay served from the page's own origin", () => {
    expect(refusal(() => checkPreviewOrigins({ relayUrl: `${PAGE}/__bfwc/relay.html` }, PAGE)).reason).toBe('ingress.same_origin_refused');
    expect(refusal(() => checkPreviewOrigins({ relayUrl: '/__bfwc/relay.html' }, PAGE)).reason).toBe('ingress.same_origin_refused');
  });

  it('accepts a cross-origin relay and returns its origin', () => {
    expect(checkPreviewOrigins({ relayUrl: RELAY, previewOrigin: previewOriginTemplate('https://{key}.preview.example.com') }, PAGE)).toBe('https://preview.example.com');
  });

  it('refuses previewOrigin without a relay', () => {
    const request = { serviceWorkerUrl: '/sw.js', unprotectedSameOrigin: true, previewOrigin: () => 'https://x.example' };
    expect(refusal(() => checkPreviewOrigins(request, PAGE)).reason).toBe('ingress.preview_origin_invalid');
  });

  it('warns once per page, and reports to the sink on every boot, when applications share the preview origin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: ShieldEvent[] = [];
    const sink = { emit: (event: ShieldEvent) => void events.push(event) };
    checkPreviewOrigins({ relayUrl: RELAY }, PAGE, sink);
    checkPreviewOrigins({ relayUrl: RELAY }, PAGE, sink);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('previewOrigin');
    expect(events.map((event) => [event.reason, event.origin])).toEqual([
      ['ingress.shared_preview_origin', 'https://preview.example.com'],
      ['ingress.shared_preview_origin', 'https://preview.example.com'],
    ]);
  });

  it('never fails the boot over a throwing sink', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sink = {
      emit() {
        throw new Error('sink down');
      },
    };
    expect(checkPreviewOrigins({ relayUrl: RELAY }, PAGE, sink)).toBe('https://preview.example.com');
  });
});

describe('control 1: per-application preview origins', () => {
  it('keys each application by a hash of (runtime, application): DNS-safe, stable, distinct across projects', () => {
    const key = previewOriginKey('project-1', 'shop');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(previewOriginKey('project-1', 'shop')).toBe(key);
    expect(previewOriginKey('project-2', 'shop')).not.toBe(key);
    expect(previewOriginKey('project-1', 'Shop')).not.toBe(key);
    // The separator keeps (a, bc) and (ab, c) apart.
    expect(previewOriginKey('a', 'bc')).not.toBe(previewOriginKey('ab', 'c'));
  });

  it('builds origins from a {key} template, never from the raw ids', () => {
    const origin = previewOriginTemplate('https://{key}.preview.example.com');
    expect(origin(previewOriginKey('p', 'App One'), { runtimeId: 'p', applicationId: 'App One' })).toBe(`https://${previewOriginKey('p', 'App One')}.preview.example.com`);
    expect(refusal(() => previewOriginTemplate('https://{id}.preview.example.com')).reason).toBe('ingress.preview_origin_invalid');
  });

  it('accepts only a bare https origin distinct from the refused ones', () => {
    const taken = [PAGE, 'https://preview.example.com'];
    expect(validatePreviewOrigin('https://abc.preview.example.com', 'a', taken)).toBe('https://abc.preview.example.com');
    expect(validatePreviewOrigin('https://abc.preview.example.com/', 'a', taken)).toBe('https://abc.preview.example.com');
    expect(validatePreviewOrigin('https://abc.preview.example.com:8443', 'a', taken)).toBe('https://abc.preview.example.com:8443');
    for (const bad of [
      'http://abc.preview.example.com',
      'https://abc.preview.example.com/__bfwc/',
      'https://abc.preview.example.com?x=1',
      'https://abc.preview.example.com#x',
      'https://user:pw@abc.preview.example.com',
      'abc.preview.example.com',
      PAGE,
      'https://preview.example.com',
      42,
    ]) {
      expect(refusal(() => validatePreviewOrigin(bad, 'a', taken)).reason).toBe('ingress.preview_origin_invalid');
    }
  });
});
