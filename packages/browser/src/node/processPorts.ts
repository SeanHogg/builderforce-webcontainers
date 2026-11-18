/**
 * The page side of a process's servers and loopback requests (processHost.ts):
 * its `listen`/`unlisten` registered on the port registry with the process's
 * assigned identity as owner, requests to its servers forwarded to its Worker
 * and streamed back, and its own loopback requests answered with its identity
 * as the caller. Who the process is comes from the page's record of the Worker
 * the message arrived on — never from the message.
 */
import { textResponse, type HttpRequestData, type HttpStreamResponse, type PortRegistry, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { EXITED, type Proc } from './procRecord.js';
import { sendResponse } from './responseWire.js';
import { notListening } from './servedPorts.js';

export class ProcessPorts {
  private nextReq = 1;

  constructor(
    private readonly ports: PortRegistry,
    private readonly post: (proc: Proc, message: HostToWorker) => void,
    private readonly identityOf: (pid: number) => SecurityContext | undefined,
  ) {}

  listen(proc: Proc, message: Extract<WorkerToHost, { type: 'listen' }>): void {
    const { port } = message;
    try {
      const registration = this.ports.listen(
        port,
        (request) => this.forward(proc, port, request),
        (request, socket) => (proc.exited ? socket.close() : proc.connections.upgrade(port, request, socket)),
        message.tcp ? (socket) => (proc.exited ? socket.close() : proc.connections.accept(port, socket)) : undefined,
        this.identityOf(proc.pid), // the owner: the process's assigned identity
      );
      proc.registrations.set(port, registration);
      this.post(proc, { type: 'listened', port, id: message.id });
    } catch (error) {
      // The port is taken: the process must learn it does not own it.
      this.post(proc, { type: 'listen-failed', port, message: (error as Error).message, id: message.id });
    }
  }

  unlisten(proc: Proc, port: number): void {
    proc.registrations.get(port)?.close();
    proc.registrations.delete(port);
  }

  /** The process asks a server in the runtime (any process's, or the page's), as itself. */
  loopback(proc: Proc, message: Extract<WorkerToHost, { type: 'loopback' }>): void {
    const { reqId } = message;
    const cancel = sendResponse((reply) => this.post(proc, reply), reqId, this.ports.request(message.port, message.request, this.identityOf(proc.pid)), () => proc.loopbacks.delete(reqId));
    proc.loopbacks.set(reqId, cancel);
  }

  /** The process exited: close its servers, fail what it was answering, cancel what it asked. */
  close(proc: Proc): void {
    for (const registration of proc.registrations.values()) registration.close();
    proc.registrations.clear();
    proc.responses.abort(() => textResponse(502, EXITED), EXITED);
    for (const cancel of [...proc.loopbacks.values()]) cancel();
    proc.loopbacks.clear();
  }

  private async forward(proc: Proc, port: number, request: HttpRequestData): Promise<HttpStreamResponse> {
    if (proc.exited) return textResponse(502, EXITED);
    const reqId = this.nextReq++;
    const response = proc.responses.expect(reqId, () => this.post(proc, { type: 'request-cancel', reqId }));
    this.post(proc, { type: 'http-request', reqId, port, request });
    return (await response) ?? notListening(port);
  }
}
