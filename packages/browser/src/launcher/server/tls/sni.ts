/**
 * The launcher's `SNICallback` (Node only): a leaf certificate per server name,
 * issued on first use and cached (`issueCert.ts`). A name the Host allowlist would
 * refuse (`hosts.ts` › `classifyHostname`) gets no certificate at all: the
 * handshake fails before any request is read.
 */
import { createSecureContext, type SecureContext } from 'node:tls';
import type { LeafCache } from './issueCert.js';

export type SniCallback = (servername: string, callback: (error: Error | null, context?: SecureContext) => void) => void;

export function createSniCallback(leaves: LeafCache, allowed: (servername: string) => boolean): SniCallback {
  const contexts = new Map<string, SecureContext>();
  return (servername, callback) => {
    const name = servername.toLowerCase();
    if (!allowed(name)) return callback(new Error(`Unknown server name "${servername}".`));
    try {
      let context = contexts.get(name);
      if (!context) {
        const leaf = leaves.issue(name);
        context = createSecureContext({ key: leaf.keyPem, cert: leaf.certPem });
        contexts.set(name, context);
      }
      callback(null, context);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
