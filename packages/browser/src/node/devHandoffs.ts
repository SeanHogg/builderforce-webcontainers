/**
 * The live dev-server handoffs (`vite`, `ng serve` run inside the runtime,
 * core shell/devHandoff.ts): which process announced one, on which port, for
 * which directory, and who that process is.
 *
 * Each entry is the ANNOUNCING process's — its pid and its page-side
 * SecurityContext (from the host's record of the Worker the message came on,
 * never from the message). An entry ends when that process withdraws it (the
 * handoff was interrupted: `unlisten` of that port) or exits, and the one before
 * it is in force again — so the dev server's root and the shared origin's
 * ingress binding never outlive the process that set them.
 */
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';

export interface DevHandoff {
  pid: number;
  port: number;
  /** The directory it serves (absolute; the handing-off shell's working directory), when it named one. */
  root?: string;
  /** Who the announcing process is (its page-side identity). */
  context?: SecurityContext;
}

export class DevHandoffs {
  /** Live entries, oldest first: the last one is in force. */
  private readonly live: DevHandoff[] = [];
  private readonly listeners = new Set<() => void>();

  /** The handoff in force (the latest live one), if any. */
  current(): DevHandoff | undefined {
    return this.live.at(-1);
  }

  /** Every live handoff, oldest first. */
  list(): readonly DevHandoff[] {
    return [...this.live];
  }

  /** A process announced a handoff on `port` (a repeat replaces its earlier entry for that port). */
  announce(handoff: DevHandoff): void {
    this.remove((entry) => entry.pid === handoff.pid && entry.port === handoff.port);
    this.live.push(Object.freeze({ ...handoff }));
    this.emit();
  }

  /** Process `pid` withdrew its handoff on `port`, or (no port) exited: its entries end. */
  end(pid: number, port?: number): void {
    if (this.remove((entry) => entry.pid === pid && (port === undefined || entry.port === port))) this.emit();
  }

  /** Told whenever the live set changes. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private remove(matches: (entry: DevHandoff) => boolean): boolean {
    const before = this.live.length;
    for (let at = this.live.length - 1; at >= 0; at--) if (matches(this.live[at]!)) this.live.splice(at, 1);
    return this.live.length !== before;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
