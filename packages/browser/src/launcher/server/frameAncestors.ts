/**
 * `frame-ancestors` for the preview origins: the host page's own origin, plus
 * the integrator's embedding origins (a VS Code webview, a hosting site).
 * Only exact https or `vscode-webview` origins: no wildcard, no http, no path.
 */
const VSCODE_WEBVIEW_ORIGIN = /^vscode-webview:\/\/[a-z0-9-]+$/i;

function isAllowedOrigin(value: string): boolean {
  if (value.includes('*')) return false; // the URL parser tolerates a wildcard host; a frame ancestor may not
  if (VSCODE_WEBVIEW_ORIGIN.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** `extra` de-duplicated; throws on an entry that is not an https or vscode-webview origin (checked before the launcher listens). */
export function validateFrameAncestors(extra: readonly string[] = []): string[] {
  for (const value of extra) {
    if (!isAllowedOrigin(value)) throw new Error(`frameAncestors: "${value}" is not an https or vscode-webview origin.`);
  }
  return [...new Set(extra)];
}

/** `pageOrigin` first, then each validated `extra` once. */
export function resolveFrameAncestors(pageOrigin: string, extra: readonly string[] = []): string[] {
  return [pageOrigin, ...validateFrameAncestors(extra).filter((value) => value !== pageOrigin)];
}
