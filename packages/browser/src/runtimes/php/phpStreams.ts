/**
 * php-wasm's output streams as the runtime needs them. php-wasm enqueues its
 * chunks as typed-array views of other kinds (Int8Array) or ArrayBuffers, and
 * the runtime's streams carry Uint8Array only.
 */

type Chunk = ArrayBufferView | ArrayBuffer;

/** A chunk's bytes as a Uint8Array (a view, no copy). */
export const bytesOf = (chunk: Chunk): Uint8Array => (chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));

/** php-wasm's stream as one of Uint8Array chunks (copies: the runtime transfers or keeps them). Cancelling it cancels the source. */
export function byteStream(source: ReadableStream<Chunk>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) return controller.close();
      const bytes = bytesOf(value);
      if (bytes.byteLength) controller.enqueue(bytes.slice());
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Read `source` to its end, handing each chunk's bytes to `sink` as they arrive. */
export async function drainBytes(source: ReadableStream<Chunk>, sink: (bytes: Uint8Array) => void): Promise<void> {
  const reader = source.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const bytes = bytesOf(value);
    if (bytes.byteLength) sink(bytes.slice());
  }
}

/** Read `source` to its end as UTF-8 text, handing it to `sink` as it arrives. */
export async function drainText(source: ReadableStream<Chunk>, sink: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  await drainBytes(source, (bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (text) sink(text);
  });
  const rest = decoder.decode();
  if (rest) sink(rest);
}
