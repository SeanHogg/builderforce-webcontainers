/**
 * Sharing one persistent database between the tabs of the host origin. The tab
 * that owns the database (databaseLeadership.ts) runs its Worker and serves
 * the others; every other tab is a follower whose database host speaks the same
 * messages (databaseProtocol.ts) over a BroadcastChannel to the owner, which
 * feeds them into its Worker through a sub-link of its multiplexer. So a
 * follower tab's processes reach the same data, through their own port.
 *
 * Channel traffic, all tagged with the sender's tab id:
 *   hello (follower → all)         who owns this database? (again on hearing a new owner: registers with it)
 *   owner (owner → all)            I do — sent on taking over and in answer to hello
 *   to-owner / to-tab              a ToDatabase / FromDatabase message
 *   bye (follower → owner)         this tab stopped using the database
 *   owner-gone (owner → all)       the owner closed it
 *
 * When the owner changes, a follower's link reports `db-reset`: its host hangs
 * up on every client (drivers see a connection error; pools reconnect) and
 * fails its pending calls. Messages sent while no owner is known wait for one.
 */
import type { DatabaseLink, FromDatabase, ToDatabase } from './databaseProtocol.js';
import type { LinkMux } from './databaseLink.js';

type TabMessage =
  | { kind: 'hello'; from: string }
  | { kind: 'owner'; from: string }
  | { kind: 'owner-gone'; from: string }
  | { kind: 'bye'; from: string; to: string }
  | { kind: 'to-owner'; from: string; to: string; message: ToDatabase }
  | { kind: 'to-tab'; from: string; to: string; message: FromDatabase };

export type ChannelFactory = new (name: string) => BroadcastChannel;

export const tabChannelName = (key: string) => `bfwc-database:${key}`;

export const newTabId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

/** A follower tab's link to whichever tab owns the database. */
export function followerLink(Channel: ChannelFactory, key: string, tabId: string): DatabaseLink {
  const channel = new Channel(tabChannelName(key));
  const listeners = new Set<(message: FromDatabase) => void>();
  const emit = (message: FromDatabase) => listeners.forEach((listener) => listener(message));
  let owner: string | undefined;
  let waiting: ToDatabase[] = [];
  let closed = false;
  const send = (message: TabMessage) => channel.postMessage(message);

  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    const message = event.data;
    if (message.from === tabId) return;
    if (message.kind === 'owner') {
      if (owner === message.from) return;
      if (owner !== undefined) emit({ type: 'db-reset' });
      owner = message.from;
      send({ kind: 'hello', from: tabId }); // register with the new owner (it answers with the database's state)
      const queued = waiting;
      waiting = [];
      for (const item of queued) send({ kind: 'to-owner', from: tabId, to: owner, message: item });
    } else if (message.kind === 'owner-gone' && message.from === owner) {
      owner = undefined;
      emit({ type: 'db-reset' });
    } else if (message.kind === 'to-tab' && message.to === tabId && message.from === owner) emit(message.message);
  };
  send({ kind: 'hello', from: tabId });

  return {
    post(message) {
      if (closed) return;
      if (owner === undefined) waiting.push(message);
      else send({ kind: 'to-owner', from: tabId, to: owner, message });
    },
    onMessage: (listener) => void listeners.add(listener),
    close() {
      if (closed) return;
      closed = true;
      if (owner !== undefined) send({ kind: 'bye', from: tabId, to: owner });
      channel.close();
    },
  };
}

/** The owner tab: serve every follower tab through its own sub-link of the Worker's multiplexer. */
export function serveFollowerTabs(Channel: ChannelFactory, key: string, tabId: string, mux: LinkMux): { close(): void } {
  const channel = new Channel(tabChannelName(key));
  const followers = new Map<string, DatabaseLink>();
  const send = (message: TabMessage) => channel.postMessage(message);

  const linkFor = (tab: string) => {
    let link = followers.get(tab);
    if (!link) {
      link = mux.subLink();
      link.onMessage((message) => send({ kind: 'to-tab', from: tabId, to: tab, message }));
      followers.set(tab, link);
    }
    return link;
  };

  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    const message = event.data;
    if (message.from === tabId) return;
    if (message.kind === 'hello') {
      send({ kind: 'owner', from: tabId });
      linkFor(message.from); // it hears db-ready (or db-failed) through its link
    } else if (message.kind === 'to-owner' && message.to === tabId) linkFor(message.from).post(message.message);
    else if (message.kind === 'bye' && message.to === tabId) {
      followers.get(message.from)?.close();
      followers.delete(message.from);
    }
  };
  send({ kind: 'owner', from: tabId });

  return {
    close() {
      for (const link of followers.values()) link.close();
      followers.clear();
      send({ kind: 'owner-gone', from: tabId });
      channel.close();
    },
  };
}
