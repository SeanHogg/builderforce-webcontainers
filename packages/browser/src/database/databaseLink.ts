/**
 * Links to a database: a Worker as a {@link DatabaseLink}, and the multiplexer
 * that lets several hosts share ONE database Worker — the owner tab's own host
 * and each other tab that proxies to it (databaseTabs.ts). Each sub-link has
 * its own connection and call ids; the multiplexer maps them onto the Worker's
 * and routes replies back. A sub-link that closes hangs up on its connections.
 */
import type { WorkerLike } from '../node/processHost.js';
import type { DatabaseLink, FromDatabase, ToDatabase } from './databaseProtocol.js';

/** The database Worker as a link; closing it terminates the Worker. */
export function workerLink(worker: WorkerLike): DatabaseLink {
  const listeners = new Set<(message: FromDatabase) => void>();
  worker.onmessage = (event) => {
    for (const listener of listeners) listener(event.data as FromDatabase);
  };
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => void listeners.add(listener),
    close: () => worker.terminate(),
  };
}

export interface LinkMux {
  /** A link with ids of its own. It hears `db-ready` even when it joins after the database opened. */
  subLink(): DatabaseLink;
}

type Route = { link: SubLink; id: number };

interface SubLink {
  emit(message: FromDatabase): void;
  connections: Map<number, number>;
}

export function createLinkMux(base: DatabaseLink): LinkMux {
  const links = new Set<SubLink>();
  const connections = new Map<number, Route>();
  const calls = new Map<number, Route>();
  let nextConn = 1;
  let nextCall = 1;
  let ready: FromDatabase | undefined;

  base.onMessage((message) => {
    switch (message.type) {
      case 'db-ready':
      case 'db-failed':
        ready = message;
        for (const link of links) link.emit(message);
        return;
      case 'db-log':
      case 'db-reset':
        for (const link of links) link.emit(message);
        return;
      case 'db-result': {
        const route = calls.get(message.callId);
        calls.delete(message.callId);
        return route?.link.emit({ ...message, callId: route.id });
      }
      default: {
        const route = connections.get(message.connId);
        if (!route) return;
        if (message.type === 'db-conn-close') {
          connections.delete(message.connId);
          route.link.connections.delete(route.id);
        }
        return route.link.emit({ ...message, connId: route.id });
      }
    }
  });

  return {
    subLink() {
      const listeners = new Set<(message: FromDatabase) => void>();
      const link: SubLink = { emit: (message) => listeners.forEach((listener) => listener(message)), connections: new Map() };
      links.add(link);
      let closed = false;
      return {
        post(message: ToDatabase) {
          if (closed || message.type === 'database-open') return; // only the owner opens the Worker
          if (message.type === 'db-call') {
            const callId = nextCall++;
            calls.set(callId, { link, id: message.callId });
            return base.post({ ...message, callId });
          }
          let connId = link.connections.get(message.connId);
          if (message.type === 'db-conn-open') {
            connId = nextConn++;
            link.connections.set(message.connId, connId);
            connections.set(connId, { link, id: message.connId });
          }
          if (connId === undefined) return;
          if (message.type === 'db-conn-close') {
            link.connections.delete(message.connId);
            connections.delete(connId);
          }
          base.post({ ...message, connId });
        },
        onMessage(listener) {
          listeners.add(listener);
          if (ready) queueMicrotask(() => listener(ready!));
        },
        close() {
          if (closed) return;
          closed = true;
          links.delete(link);
          for (const connId of link.connections.values()) {
            connections.delete(connId);
            base.post({ type: 'db-conn-close', connId });
          }
          link.connections.clear();
          for (const [callId, route] of calls) if (route.link === link) calls.delete(callId);
        },
      };
    },
  };
}
