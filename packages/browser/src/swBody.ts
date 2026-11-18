/**
 * The preview ingress request-body limit (W10 control 3, service-worker side).
 * Pure (no worker globals), so it is tested with fakes.
 */

/** The parts of a fetch Request the body limit reads. */
export interface BodySource {
  headers: { get(name: string): string | null };
  /** A stream where the browser exposes request streams; absent or null elsewhere. */
  body?: ReadableStream<Uint8Array> | null;
  blob(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Read the body of a request that has one (never call it for GET/HEAD) without
 * handing on more than `limit` bytes. `null` = too large.
 *
 * - Content-Length is checked first, but it is a forbidden request header: pages
 *   cannot set it and browsers usually do not show it to the service worker, so
 *   this is a cheap early exit, not the control.
 * - With a request stream, a running count stops reading (and cancels the
 *   stream) as soon as the limit is passed — never more than the limit is held.
 * - Without one (`body` absent or null, e.g. Firefox), `blob()` is the only way
 *   to read it: the browser buffers the whole body before its size is known.
 *   Residual: an oversized body is refused, but only after the browser has held
 *   it (as a Blob, outside the JS heap where the browser can).
 */
export async function readBoundedBody(source: BodySource, limit: number): Promise<ArrayBuffer | null> {
  const declared = Number(source.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!(source.body instanceof ReadableStream)) {
    const blob = await source.blob();
    return blob.size > limit ? null : blob.arrayBuffer();
  }
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
