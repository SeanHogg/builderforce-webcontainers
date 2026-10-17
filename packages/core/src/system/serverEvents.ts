/**
 * Who hears about servers in a runtime: a port opening or closing, and a
 * server becoming reachable (which a dev-server handoff announces without
 * opening a port). One instance per runtime — the core `Kernel` and the
 * browser's process host both own one, so the listener contract is the same.
 */

export interface ServerAddress {
  port: number;
  /** Where a browser reaches it (the preview URL for that port). */
  url: string;
}

export interface PortChange extends ServerAddress {
  type: 'open' | 'close';
}

export class ServerEvents {
  private readonly listening = new Set<(server: ServerAddress) => void>();
  private readonly changes = new Set<(change: PortChange) => void>();

  /** A server started listening (or a dev script handed off to the preview); `url` loads it in an iframe. */
  onListening(listener: (server: ServerAddress) => void): () => void {
    this.listening.add(listener);
    return () => this.listening.delete(listener);
  }

  /** A virtual server opened or closed its port. */
  onPortChange(listener: (change: PortChange) => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  /** Report a port table change; an opened port is also a server listening. */
  portChanged(change: PortChange): void {
    for (const listener of this.changes) listener(change);
    if (change.type === 'open') this.announce({ port: change.port, url: change.url });
  }

  /** Report a reachable server that did not open a port of its own. */
  announce(server: ServerAddress): void {
    for (const listener of this.listening) listener(server);
  }
}
