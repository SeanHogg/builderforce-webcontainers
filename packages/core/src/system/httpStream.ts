/**
 * Building blocks for streamed HTTP between programs and hosts: a body stream
 * fed by pushes (a server's `res.write`, chunks arriving over postMessage),
 * buffering helpers for callers that want the whole response, and the in-memory
 * byte pipe an upgraded connection runs over.
 */
import type { ByteChannel, HttpResponseData, HttpResponseHead, HttpStreamResponse } from './types.js';

/** Bytes a body stream queues for a reader that is not keeping up before `push` reports it full. */
export const BODY_HIGH_WATER_MARK = 1024 * 1024;

export interface PushStream {
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Queue a chunk; ignored once the stream is closed or cancelled. Returns false
   * when the queue is at its high-water mark (or the reader is gone): a producer
   * that can wait should, until `ready()` resolves.
   */
  push(chunk: Uint8Array): boolean;
  /** Resolves when the reader wants more (pulls below the high-water mark), or the stream is done. */
  ready(): Promise<void>;
  end(): void;
  /** End with an error: the reader sees a failed read (a truncated response). */
  fail(error: unknown): void;
  /** True once ended, failed or cancelled. */
  readonly done: boolean;
}

/**
 * A body stream fed from outside, pull-based: it queues up to `highWaterMark`
 * bytes for a slow reader, and `push`/`ready` tell the producer when to wait.
 * `onCancel` runs when the reader hangs up before the end.
 */
export function pushStream(onCancel?: (reason: unknown) => void, highWaterMark = BODY_HIGH_WATER_MARK): PushStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  let waiting: Array<() => void> = [];
  const wake = () => {
    const resume = waiting;
    waiting = [];
    for (const go of resume) go();
  };
  const hasRoom = () => !done && (controller.desiredSize ?? 0) > 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => void (controller = c),
      pull: wake, // the reader drained below the mark: producers may go on
      cancel: (reason) => {
        if (done) return;
        done = true;
        wake();
        onCancel?.(reason);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark }),
  );
  return {
    stream,
    push(chunk) {
      if (!done && chunk.byteLength) controller.enqueue(chunk);
      return hasRoom();
    },
    ready() {
      return done || hasRoom() ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve));
    },
    end() {
      if (done) return;
      done = true;
      controller.close();
      wake();
    },
    fail(error) {
      if (done) return;
      done = true;
      controller.error(error);
      wake();
    },
    get done() {
      return done;
    },
  };
}

/** A stream holding exactly `bytes`. */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A complete plain-text response (errors: nothing listening, the server exited). */
export function textResponse(status: number, text: string): HttpStreamResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: bytesStream(new TextEncoder().encode(text)) };
}

/** Read a body stream to the end. */
export async function readBody(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Wait for a streamed response's whole body. */
export async function bufferResponse(response: HttpStreamResponse): Promise<HttpResponseData> {
  return { ...headOf(response), body: await readBody(response.body) };
}

/** The status line and headers alone (plain data, safe to post). */
export function headOf(response: HttpResponseHead): HttpResponseHead {
  return { status: response.status, statusText: response.statusText, headers: response.headers };
}

/**
 * Feed a body stream to `sink` chunk by chunk. Returns a cancel that hangs up
 * on the producer; `sink.end` gets the error message when the stream failed.
 */
export function drainBody(stream: ReadableStream<Uint8Array>, sink: { chunk(data: Uint8Array): void; end(error?: string): void }): () => void {
  const reader = stream.getReader();
  let cancelled = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || cancelled) break;
        sink.chunk(value);
      }
      if (!cancelled) sink.end();
    } catch (error) {
      if (!cancelled) sink.end(error instanceof Error ? error.message : String(error));
    }
  })();
  return () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
}

class ChannelEnd implements ByteChannel {
  peer!: ChannelEnd;
  closed = false;
  private readonly data = new Set<(data: Uint8Array) => void>();
  private readonly closes = new Set<() => void>();

  send(data: Uint8Array): void {
    if (this.closed) return;
    const copy = new Uint8Array(data); // a copy (a Buffer's slice would be a view)
    queueMicrotask(() => {
      if (!this.peer.closed) for (const listener of this.peer.data) listener(copy);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Delivered after any data already sent, like a FIN after the last segment.
    queueMicrotask(() => {
      if (this.peer.closed) return; // both hung up at once: neither needs telling
      this.peer.closed = true;
      for (const listener of this.peer.closes) listener();
    });
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
}

/** Two connected ends: bytes sent on one arrive (asynchronously, in order) on the other. */
export function createChannelPair(): [ByteChannel, ByteChannel] {
  const a = new ChannelEnd();
  const b = new ChannelEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
