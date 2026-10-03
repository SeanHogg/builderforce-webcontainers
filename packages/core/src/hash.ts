/**
 * A short, deterministic content hash: cache-busting file names in a build and
 * stable scope ids for component styles. Not cryptographic, and does not need to
 * be — it only has to change when the bytes change. Synchronous (two FNV-1a
 * variants mixed), so it works inside a bundler's resolve hook without
 * `crypto.subtle`, which is async and missing outside secure contexts.
 */
const encoder = new TextEncoder();

export function contentHash(data: string | Uint8Array, length = 8): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  let h1 = 0x811c9dc5;
  let h2 = 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    h1 = Math.imul(h1 ^ byte, 0x01000193);
    h2 = Math.imul(h2 ^ byte, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return hex.slice(0, length);
}
