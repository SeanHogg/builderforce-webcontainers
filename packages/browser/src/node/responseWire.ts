/**
 * Streamed HTTP responses over postMessage, used on both sides of the
 * page ↔ process-worker boundary: the side that holds a response sends it as
 * head / chunk / end messages as the server writes it, and the side that asked
 * rebuilds an `HttpStreamResponse` whose body stream is fed by them. A reader
 * that cancels the body sends `request-cancel` back, so the server hears the
 * client hang up.
 */
import { drainBody, headOf, pushStream, type HttpStreamResponse, type PushStream } from '@seanhogg/builderforce-webcontainers-core';
import type { ResponseMessage } from './protocol.js';

const encoder = new TextEncoder();

/**
 * Send `response` as messages once it resolves (`undefined`: nothing listens).
 * A rejected handler becomes a 500 carrying the error. Returns a cancel for
 * when the requester hangs up; `onDone` runs once, when the exchange is over.
 */
export function sendResponse(post: (message: ResponseMessage) => void, reqId: number, response: Promise<HttpStreamResponse | undefined>, onDone?: () => void): () => void {
  let finished = false;
  let stop: (() => void) | undefined;
  const done = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  response.then(
    (res) => {
      if (finished) return void res?.body.cancel().catch(() => undefined);
      if (!res) {
        post({ type: 'response-head', reqId, head: null });
        return done();
      }
      post({ type: 'response-head', reqId, head: headOf(res) });
      stop = drainBody(res.body, {
        chunk: (data) => post({ type: 'response-chunk', reqId, data }),
        end: (error) => {
          post(error ? { type: 'response-end', reqId, error } : { type: 'response-end', reqId });
          done();
        },
      });
    },
    (error: unknown) => {
      if (finished) return;
      post({ type: 'response-head', reqId, head: { status: 500, headers: { 'content-type': 'text/plain' } } });
      post({ type: 'response-chunk', reqId, data: encoder.encode(String(error instanceof Error ? error.stack : error)) });
      post({ type: 'response-end', reqId });
      done();
    },
  );
  return () => {
    stop?.();
    done();
  };
}

/** Rebuilds streamed responses from the messages answering requests this side sent. */
export class ResponseReceiver {
  private readonly heads = new Map<number, { resolve(response: HttpStreamResponse | undefined): void; cancel(): void }>();
  private readonly bodies = new Map<number, PushStream>();

  /** The response to request `reqId`; `cancel` runs if its reader hangs up before the end. */
  expect(reqId: number, cancel: () => void): Promise<HttpStreamResponse | undefined> {
    return new Promise((resolve) => this.heads.set(reqId, { resolve, cancel }));
  }

  receive(message: ResponseMessage): void {
    const { reqId } = message;
    if (message.type === 'response-head') {
      const waiting = this.heads.get(reqId);
      this.heads.delete(reqId);
      if (!waiting) return;
      if (!message.head) return waiting.resolve(undefined);
      const body = pushStream(() => {
        this.bodies.delete(reqId);
        waiting.cancel();
      });
      this.bodies.set(reqId, body);
      waiting.resolve({ ...message.head, body: body.stream });
    } else if (message.type === 'response-chunk') {
      this.bodies.get(reqId)?.push(message.data);
    } else {
      const body = this.bodies.get(reqId);
      this.bodies.delete(reqId);
      if (message.error) body?.fail(new Error(message.error));
      else body?.end();
    }
  }

  /** The other side is gone: waiting requests get `fallback`, bodies in flight break off with `reason`. */
  abort(fallback: () => HttpStreamResponse | undefined, reason: string): void {
    for (const { resolve } of this.heads.values()) resolve(fallback());
    this.heads.clear();
    for (const body of this.bodies.values()) body.fail(new Error(reason));
    this.bodies.clear();
  }
}
