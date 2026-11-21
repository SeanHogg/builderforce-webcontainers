/**
 * What a preview origin's responses may reach beyond their own origin (the CSP
 * egress its service worker stamps): the package CDN's origins plus the
 * embedder's `previewEgress`. Host-side only (see relayConfig.ts).
 */
import { esmShCdnFactory, type PackageCdnFactory } from '@seanhogg/builderforce-webcontainers-core';
import { MAX_EGRESS, egressSources, isEgressSource } from './previewCsp.js';
import type { CommonRuntimeOptions } from './runtimeOptions.js';

/** The CDN factory's own `origins` as declared (`cdn` unset: esm.sh's), unchecked. */
const declaredCdnOrigins = (cdn: PackageCdnFactory | undefined): readonly string[] => (cdn ?? esmShCdnFactory).origins ?? [];

/**
 * The origins previews load packages from: the CDN factory's `origins` (`cdn`
 * unset: esm.sh's) that are well-formed egress sources (`egressSources`: https/wss
 * origins, no path), lowercased. Anything else is dropped (see `createPreviewEgress`).
 */
export function cdnOriginsOf(cdn: PackageCdnFactory | undefined): readonly string[] {
  return egressSources(declaredCdnOrigins(cdn));
}

export const CDN_WITHOUT_ORIGINS_WARNING =
  '[bfwc] The custom `cdn` declares no `origins`: preview package imports from it will be blocked by the preview CSP ' +
  'unless the CDN factory declares `origins` or its origin is listed in `previewEgress`.';

/** The warning for CDN `origins` that are not egress sources (`http:`, a path, a quote …), naming them. */
export function cdnOriginsDroppedWarning(dropped: readonly string[]): string {
  return (
    `[bfwc] The \`cdn\` factory's \`origins\` include ${dropped.map((origin) => JSON.stringify(origin)).join(', ')}, ` +
    'which are not https/wss origins (no path): they are left out of the preview CSP, so preview package imports from them are blocked.'
  );
}

/** The warning for well-formed CDN `origins` past the egress limit, counting them. */
export function cdnOriginsTruncatedWarning(count: number): string {
  return (
    `[bfwc] The \`cdn\` factory declares ${count} more origin${count === 1 ? '' : 's'} than a preview's egress holds (${MAX_EGRESS}): ` +
    'only the first are in the preview CSP, so preview package imports from the rest are blocked.'
  );
}

/**
 * The egress for an application's previews (`undefined`: the workspace's): CDN
 * origins, then the declared list, deduplicated. A custom `cdn` without `origins`,
 * CDN `origins` that are not egress sources, and well-formed ones past
 * `MAX_EGRESS` (a separate warning), are warned about once, here
 * (once per runtime).
 */
export function createPreviewEgress(
  options: Pick<CommonRuntimeOptions, 'cdn' | 'previewEgress'>,
  warn: (message: string) => void = (message) => console.warn(message),
): (applicationId?: string) => readonly string[] {
  if (options.cdn && options.cdn.origins === undefined) warn(CDN_WITHOUT_ORIGINS_WARNING);
  const cdnOrigins = cdnOriginsOf(options.cdn);
  const declared = declaredCdnOrigins(options.cdn);
  // Malformed origins and the valid ones past MAX_EGRESS are told apart: a valid origin is never called malformed.
  const malformed = declared.filter((origin) => !isEgressSource(origin));
  if (malformed.length > 0) warn(cdnOriginsDroppedWarning(malformed));
  const valid = new Set(declared.filter(isEgressSource).map((origin) => origin.toLowerCase()));
  if (valid.size > cdnOrigins.length) warn(cdnOriginsTruncatedWarning(valid.size - cdnOrigins.length));
  return (applicationId) => {
    const declared = typeof options.previewEgress === 'function' ? options.previewEgress(applicationId) : (options.previewEgress ?? []);
    return [...new Set([...cdnOrigins, ...declared])];
  };
}
