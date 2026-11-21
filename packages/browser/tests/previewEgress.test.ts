import { describe, expect, it } from 'vitest';
import { createEsmShCdnFactory, esmShCdnFactory, type PackageCdnFactory } from '@seanhogg/builderforce-webcontainers-core';
import { MAX_EGRESS } from '../src/previewCsp.js';
import { CDN_WITHOUT_ORIGINS_WARNING, cdnOriginsDroppedWarning, cdnOriginsOf, cdnOriginsTruncatedWarning, createPreviewEgress } from '../src/previewEgress.js';
import { PREVIEW_DEFAULT_EGRESS } from '../src/previewHeaders.js';

const plainCdn: PackageCdnFactory = () => ({ urlFor: (name) => `https://cdn.example.com/${name}` });
const withOrigins = (origins: readonly string[]): PackageCdnFactory => Object.assign((() => ({ urlFor: (name: string) => `${origins[0]}/${name}` })) as PackageCdnFactory, { origins });

function egressFor(options: Parameters<typeof createPreviewEgress>[0]) {
  const warnings: string[] = [];
  const egress = createPreviewEgress(options, (message) => warnings.push(message));
  return { egress, warnings };
}

describe('the preview egress composition: CDN origins + previewEgress', () => {
  it('default cdn: esm.sh is present, with the declared list on top', () => {
    const { egress, warnings } = egressFor({ previewEgress: ['https://api.example.com'] });
    expect(egress()).toEqual(['https://esm.sh', 'https://api.example.com']);
    expect(warnings).toEqual([]);
  });

  it('a custom cdn with origins: its origins are in the egress, esm.sh is not', () => {
    const { egress, warnings } = egressFor({ cdn: withOrigins(['https://cdn.example.com']), previewEgress: ['https://tile.openstreetmap.org'] });
    expect(egress()).toEqual(['https://cdn.example.com', 'https://tile.openstreetmap.org']);
    expect(warnings).toEqual([]);
  });

  it('a custom cdn without origins: warned once (not per call), esm.sh not added', () => {
    const { egress, warnings } = egressFor({ cdn: plainCdn, previewEgress: ['https://cdn.example.com'] });
    expect(egress()).toEqual(['https://cdn.example.com']);
    expect(egress('app-1')).toEqual(['https://cdn.example.com']);
    expect(warnings).toEqual([CDN_WITHOUT_ORIGINS_WARNING]);
    expect(CDN_WITHOUT_ORIGINS_WARNING).toContain('previewEgress');
  });

  it('a per-application previewEgress is added on top of the CDN origins, deduplicated', () => {
    const { egress } = egressFor({ previewEgress: (applicationId) => (applicationId ? ['https://esm.sh', `https://${applicationId}.example.com`] : []) });
    expect(egress(undefined)).toEqual(['https://esm.sh']);
    expect(egress('a1')).toEqual(['https://esm.sh', 'https://a1.example.com']);
  });

  it('a custom cdn that declares no origins on purpose (empty) is not warned about', () => {
    const { egress, warnings } = egressFor({ cdn: withOrigins([]) });
    expect(egress()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('CDN origins go through egressSources: http:, paths and junk are dropped and named in one warning per runtime', () => {
    const { egress, warnings } = egressFor({ cdn: withOrigins(['https://CDN.example.com', 'http://insecure.example.com', 'https://cdn.example.com/esm', "https://x.example 'unsafe-inline'"]) });
    expect(egress()).toEqual(['https://cdn.example.com']);
    expect(egress('app-1')).toEqual(['https://cdn.example.com']);
    expect(warnings).toEqual([cdnOriginsDroppedWarning(['http://insecure.example.com', 'https://cdn.example.com/esm', "https://x.example 'unsafe-inline'"])]);
    expect(warnings[0]).toContain('http://insecure.example.com');
    expect(cdnOriginsOf(withOrigins(['http://insecure.example.com']))).toEqual([]);
  });

  it('regression: valid CDN origins past the egress limit are reported as truncated, never as malformed', () => {
    const many = Array.from({ length: MAX_EGRESS + 3 }, (_, i) => `https://cdn${i}.example.com`);
    const { egress, warnings } = egressFor({ cdn: withOrigins([...many, 'http://insecure.example.com']) });
    expect(egress()).toEqual(many.slice(0, MAX_EGRESS));
    expect(warnings).toEqual([cdnOriginsDroppedWarning(['http://insecure.example.com']), cdnOriginsTruncatedWarning(3)]);
    expect(warnings[1]).toContain(`(${MAX_EGRESS})`);
    // Duplicates (case aside) are one origin, not a truncation.
    expect(egressFor({ cdn: withOrigins(['https://a.example.com', 'https://A.example.com']) }).warnings).toEqual([]);
  });

  it('createEsmShCdnFactory({ origin }) declares a proper origin, so nothing is dropped', () => {
    const { egress, warnings } = egressFor({ cdn: createEsmShCdnFactory({ origin: 'https://Mirror.Example.com:8443/esm/' }) });
    expect(egress()).toEqual(['https://mirror.example.com:8443']);
    expect(warnings).toEqual([]);
  });

  it("the preview-headers default egress equals the default CDN factory's origins (one source, pinned)", () => {
    expect(cdnOriginsOf(undefined)).toEqual(esmShCdnFactory.origins);
    expect([...PREVIEW_DEFAULT_EGRESS]).toEqual([...cdnOriginsOf(undefined)]);
  });
});
