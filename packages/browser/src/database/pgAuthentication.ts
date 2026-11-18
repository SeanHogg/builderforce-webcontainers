/**
 * The gateway's authentication, on the page (make.md › PRD 31 §4 W10, control 5).
 * Every client connection is admitted here before a byte of it reaches the
 * database: this tab knows who dialled (the `PortRegistry`'s caller, never the
 * client's `application_name`) and holds this tab's generated logins, while the
 * database Worker it relays to may belong to another tab.
 *
 * The start-up is read with the gateway's frame reader: `SSLRequest` /
 * `GSSENCRequest` get `N`; the v3 start-up message goes to the
 * {@link ConnectionAuthenticator}, which refuses at once or asks for a password
 * (`AuthenticationCleartextPassword` — the socket is the runtime's in-memory
 * pipe, never a network, so SCRAM would add nothing but clients it breaks) and
 * checks the `PasswordMessage`. A refusal is a Postgres `FATAL` ErrorResponse
 * (28000 / 28P01 / 3D000) and a hang-up, so unmodified drivers report it as
 * usual. Once admitted, the start-up message and whatever followed it are handed
 * on (`accepted`) for the Worker's gateway to answer (`AuthenticationOk`, …).
 *
 * Flow control: the bytes consumed here (requests, the password) are credited
 * here; the ones handed on are credited by whoever reads them next.
 */
import type { ByteChannel, SecurityContext, ShieldDecision, ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
import { FrameReader, type FrontendPacket } from './pgFrameReader.js';
import { CANCEL_REQUEST, GSSENC_REQUEST, PASSWORD_MESSAGE, PROTOCOL_V3, SSL_REQUEST, authenticationCleartextPassword, errorResponse } from './pgMessages.js';

/** What a connection asks for, and who (page-side) dialled it. */
export interface StartupRequest {
  /** Undefined when the listener was handed no caller: refuse. */
  readonly caller: SecurityContext | undefined;
  readonly user: string;
  readonly database: string;
  /** Client-supplied: telemetry only, never a decision input. */
  readonly applicationName?: string;
}

/** Refuse; admit without a password (`verify` absent); or ask for one and decide on it. */
export type Admission = { readonly allow: false; readonly reason: ShieldReasonCode } | { readonly allow: true; verify?(password: string): ShieldDecision };

export type ConnectionAuthenticator = (request: StartupRequest) => Admission;

export interface AuthenticateOptions {
  /** The gateway's end of the client's connection. */
  socket: ByteChannel;
  caller: SecurityContext | undefined;
  authenticate: ConnectionAuthenticator;
  /** Admitted: `forward` is the start-up message and everything after it; `socket` is the caller's to relay from now on. */
  accepted(forward: Uint8Array): void;
  /** Refused (telemetry). */
  refused?(reason: ShieldReasonCode, request: StartupRequest | undefined): void;
}

const NO = new Uint8Array([0x4e]); // 'N'
const decoder = new TextDecoder();

function refusal(reason: ShieldReasonCode, request: StartupRequest): [sqlState: string, message: string] {
  switch (reason) {
    case 'db.auth_failed':
      return ['28P01', `password authentication failed for user "${request.user}"`];
    case 'db.not_owner':
      return ['3D000', `database "${request.database}" does not exist`];
    default:
      return ['28000', `no access for user "${request.user}" to database "${request.database}": this service may not connect to it`];
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Admit or refuse one client connection; see the module comment. */
export function authenticateConnection(options: AuthenticateOptions): { cancel(): void } {
  const { socket } = options;
  const reader = new FrameReader();
  let request: StartupRequest | undefined;
  let startup: Uint8Array | undefined;
  let verify: ((password: string) => ShieldDecision) | undefined;
  let done = false;

  socket.manualFlowControl();
  const finish = () => {
    done = true;
    offData();
    offClose();
  };
  const fatal = (sqlState: string, message: string) => {
    finish();
    socket.send(errorResponse(sqlState, message));
    socket.close();
  };
  const refuse = (reason: ShieldReasonCode) => {
    options.refused?.(reason, request);
    fatal(...refusal(reason, request!));
  };
  /** Bytes that arrived after admission, before the hand-over. */
  let admitted: Uint8Array[] | undefined;
  /**
   * Hand on the start-up and the packets framed after it (pipelined by the
   * client); a broken one ends the connection instead. The hand-over waits a
   * microtask: admission happens while the socket is delivering a chunk, and a
   * listener the caller adds then (its relay) would be handed that same chunk
   * again — duplicating the start-up or the password into the session.
   */
  const admit = (rest: FrontendPacket[]) => {
    const broken = rest.find((packet) => packet.kind === 'error');
    if (broken?.kind === 'error') return fatal('08P01', broken.message);
    admitted = [startup!, ...rest.map((packet) => (packet.kind === 'message' ? packet.bytes : new Uint8Array())), reader.drain()];
    queueMicrotask(() => {
      if (done) return; // hung up meanwhile
      finish();
      options.accepted(concat(admitted!));
    });
  };

  const receive = (data: Uint8Array) => {
    if (done) return;
    if (admitted) return void admitted.push(data);
    const packets = reader.push(data);
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i]!;
      if (packet.kind === 'error') return fatal('08P01', packet.message);
      if (packet.kind === 'startup') {
        if (packet.code === SSL_REQUEST || packet.code === GSSENC_REQUEST) {
          socket.consumed(packet.bytes.length);
          socket.send(NO);
          continue;
        }
        if (packet.code === CANCEL_REQUEST) {
          finish();
          return socket.close(); // cancelling a running query is not supported
        }
        if (packet.code !== PROTOCOL_V3) return fatal('08P01', `Unsupported frontend protocol ${packet.code >>> 16}.${packet.code & 0xffff}.`);
        const user = packet.params.user ?? '';
        request = { caller: options.caller, user, database: packet.params.database || user, applicationName: packet.params.application_name };
        startup = packet.bytes;
        const admission = options.authenticate(request);
        if (!admission.allow) return refuse(admission.reason);
        if (!admission.verify) return admit(packets.slice(i + 1));
        verify = admission.verify;
        socket.send(authenticationCleartextPassword());
        continue;
      }
      // A typed message: only the password is expected before admission.
      if (!verify || packet.type !== PASSWORD_MESSAGE) return fatal('08P01', 'Expected a password message during authentication.');
      socket.consumed(packet.bytes.length);
      const body = packet.bytes.subarray(5);
      const end = body.indexOf(0);
      const decision = verify(decoder.decode(end < 0 ? body : body.subarray(0, end)));
      if (!decision.allow) return refuse(decision.reason);
      return admit(packets.slice(i + 1));
    }
  };

  const offData = socket.onData(receive);
  const offClose = socket.onClose(finish);
  return { cancel: () => !done && fatal('57P01', 'terminating connection due to administrator command') };
}
