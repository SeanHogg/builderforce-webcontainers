/**
 * The slice of the Postgres wire protocol (v3) the gateway speaks itself: the
 * start-up codes, the backend messages it answers with (the handshake, errors),
 * the frontend messages it sends on a client's behalf (`Sync`, `ROLLBACK`), and
 * reading the transaction status out of the engine's replies. Everything else
 * passes through to the engine untouched. Framing what clients send is
 * pgFrameReader.ts.
 */

export const PROTOCOL_V3 = 196608;
export const SSL_REQUEST = 80877103;
export const GSSENC_REQUEST = 80877104;
export const CANCEL_REQUEST = 80877102;

/** Typed frontend messages the gateway acts on itself. */
export const TERMINATE = 0x58; // 'X'
const READY_FOR_QUERY = 0x5a; // 'Z'

/** The transaction status a `ReadyForQuery` reports: idle, in a transaction, in a failed transaction. */
export type TransactionStatus = 'I' | 'T' | 'E';

const encoder = new TextEncoder();

/** A typed backend message: `type`, then int32 length, then `body`. */
function backend(type: string, ...parts: Array<Uint8Array | string | number>): Uint8Array {
  const bodies = parts.map((part) => {
    if (typeof part === 'string') return encoder.encode(`${part}\0`);
    if (typeof part === 'number') {
      const int = new Uint8Array(4);
      new DataView(int.buffer).setInt32(0, part);
      return int;
    }
    return part;
  });
  const length = bodies.reduce((sum, body) => sum + body.length, 4);
  const out = new Uint8Array(1 + length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, length);
  let at = 5;
  for (const body of bodies) {
    out.set(body, at);
    at += body.length;
  }
  return out;
}

export const authenticationOk = () => backend('R', 0);
export const parameterStatus = (name: string, value: string) => backend('S', name, value);
export const backendKeyData = (processId: number, secretKey: number) => backend('K', processId, secretKey);
export const readyForQuery = (status: TransactionStatus) => backend('Z', encoder.encode(status));

/** An `ErrorResponse` (`severity` FATAL ends the connection). */
export function errorResponse(sqlState: string, message: string, severity: 'ERROR' | 'FATAL' = 'FATAL'): Uint8Array {
  const field = (code: string, value: string) => encoder.encode(`${code}${value}\0`);
  return backend('E', field('S', severity), field('V', severity), field('C', sqlState), field('M', message), new Uint8Array([0]));
}

/** A simple `Query` message. */
export const queryMessage = (sql: string) => backend('Q', sql);
/** A `Sync` message: ends an extended-protocol exchange. */
export const syncMessage = () => backend('S');

/**
 * The status of the last `ReadyForQuery` in a backend reply, or undefined when
 * it holds none: the exchange is unfinished (extended protocol before `Sync`,
 * `COPY` before `CopyDone`), whatever the reply's size.
 */
export function lastTransactionStatus(reply: Uint8Array): TransactionStatus | undefined {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  let status: TransactionStatus | undefined;
  for (let at = 0; at + 5 <= reply.length; ) {
    const length = view.getInt32(at + 1);
    if (reply[at] === READY_FOR_QUERY && length === 5) status = String.fromCharCode(reply[at + 5]!) as TransactionStatus;
    at += 1 + length;
  }
  return status;
}
