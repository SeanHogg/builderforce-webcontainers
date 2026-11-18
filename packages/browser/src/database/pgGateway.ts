/**
 * One client connection to the Postgres wire gateway, over its byte channel.
 * The gateway answers the start-up itself — `SSLRequest`/`GSSENCRequest` get
 * `N` (plain connection), the start-up message gets trust authentication
 * (`AuthenticationOk`), the server's parameters, a backend key and
 * `ReadyForQuery` — then runs the client's messages on the engine through its
 * scheduler session, one batch at a time, and sends the replies back.
 * `Terminate` closes the connection; it never reaches the engine, whose single
 * session the other connections still use. A protocol violation (an oversized
 * or malformed packet, HTTP sent to the port) gets `FATAL 08P01` and a hang-up.
 *
 * Backpressure both ways: what the client sent is credited as the gateway runs
 * it (beyond a small queue, {@link QUEUED_BYTES}), so a client cannot pile up
 * unbounded work; and the next batch runs only while the client has consumed
 * the replies to within {@link REPLY_WINDOW}, so a slow reader is not flooded.
 *
 * Any database name is accepted: the engine has one database (`postgres`), and
 * every connection reaches it.
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { EngineScheduler } from './engineScheduler.js';
import { FrameReader } from './pgFrameReader.js';
import { CANCEL_REQUEST, GSSENC_REQUEST, PROTOCOL_V3, SSL_REQUEST, TERMINATE, authenticationOk, backendKeyData, errorResponse, parameterStatus, readyForQuery } from './pgMessages.js';

/** Bytes of framed, not yet run messages credited ahead of running them. */
export const QUEUED_BYTES = 256 * 1024;
/** Reply bytes the client may leave unconsumed before its next batch waits. */
export const REPLY_WINDOW = 256 * 1024;

export interface GatewayConnectionOptions {
  /** The gateway's end of the client's connection. */
  channel: ByteChannel;
  scheduler: EngineScheduler;
  /** `ParameterStatus` values announced at start-up (`server_version`, …). */
  readonly parameters: Readonly<Record<string, string>>;
  processId: number;
}

export interface GatewayConnection {
  /** Hang up on the client (an import, a reset or a close replaces what it talks to); its open transaction is rolled back. */
  close(): void;
}

const NO = new Uint8Array([0x4e]); // 'N'

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface Batch {
  messages: Uint8Array[];
  size: number;
  /** `Terminate`: hang up once what came before it has run. */
  terminate?: boolean;
}

export function serveGatewayConnection(options: GatewayConnectionOptions): GatewayConnection {
  const { channel } = options;
  const reader = new FrameReader();
  const queue: Batch[] = [];
  let closed = false;
  let busy = false;
  let received = 0;
  let credited = 0;
  /** Bytes of framed messages not yet run. */
  let pending = 0;
  let replyInFlight = 0;

  const send = (bytes: Uint8Array) => {
    if (closed || !bytes.length) return;
    replyInFlight += bytes.length;
    channel.send(bytes);
  };
  const end = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    session.close();
    channel.close();
  };
  const fatal = (sqlState: string, message: string) => {
    send(errorResponse(sqlState, message));
    end();
  };
  const session = options.scheduler.session(() => fatal('25P03', 'terminating connection due to idle-in-transaction timeout'));

  const credit = () => {
    const target = received - Math.max(0, pending - QUEUED_BYTES);
    if (target > credited) channel.consumed(target - credited);
    credited = Math.max(credited, target);
  };

  const pump = () => {
    if (busy || closed || replyInFlight > REPLY_WINDOW) return;
    const batch = queue.shift();
    if (!batch) return;
    if (batch.terminate) return end();
    busy = true;
    void session
      .exec(concat(batch.messages))
      .then(send, end)
      .finally(() => {
        busy = false;
        pending -= batch.size;
        credit();
        pump();
      });
  };

  const startUp = (code: number, params: Record<string, string>) => {
    if (code === SSL_REQUEST || code === GSSENC_REQUEST) return send(NO);
    if (code === CANCEL_REQUEST) return end(); // cancelling a running query is not supported
    if (code !== PROTOCOL_V3) return fatal('08P01', `Unsupported frontend protocol ${code >>> 16}.${code & 0xffff}.`);
    const parameters = { ...options.parameters, application_name: params.application_name ?? '' };
    send(
      concat([
        authenticationOk(),
        ...Object.entries(parameters).map(([name, value]) => parameterStatus(name, value)),
        backendKeyData(options.processId, (Math.random() * 0x7fffffff) | 0),
        readyForQuery('I'),
      ]),
    );
  };

  const receive = (data: Uint8Array) => {
    if (closed) return;
    received += data.length;
    let batch: Batch = { messages: [], size: 0 };
    const flush = () => {
      if (batch.messages.length) queue.push(batch);
      pending += batch.size;
      batch = { messages: [], size: 0 };
    };
    for (const packet of reader.push(data)) {
      if (packet.kind === 'error') {
        flush();
        return fatal('08P01', packet.message);
      }
      if (packet.kind === 'startup') startUp(packet.code, packet.params);
      else if (packet.type === TERMINATE) {
        flush();
        queue.push({ messages: [], size: 0, terminate: true });
      } else {
        batch.messages.push(packet.bytes);
        batch.size += packet.bytes.length;
      }
      if (closed) return;
    }
    flush();
    credit();
    pump();
  };

  channel.manualFlowControl();
  channel.onData(receive);
  channel.onConsumed((bytes) => {
    replyInFlight = Math.max(0, replyInFlight - bytes);
    pump();
  });
  channel.onClose(() => {
    closed = true;
    session.close();
  });
  return { close: end };
}
