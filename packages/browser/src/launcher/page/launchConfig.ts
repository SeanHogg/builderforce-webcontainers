/**
 * The launcher page's link to its server: the per-launch token (from the URL's
 * fragment, forwarded as a header on every `/__bf/*` request), `launch.json`, the
 * project tree, and the change stream (read with `fetch`, since `EventSource`
 * cannot send the token header).
 */
import { LAUNCH_PATHS, LAUNCH_TOKEN_HEADER, LAUNCH_TOKEN_PARAM, type LaunchInfo, type ProjectChange, type ProjectSnapshot } from '../protocol.js';

/** The token in a launch URL's fragment (`#token=…`), or null. */
export function readLaunchToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get(LAUNCH_TOKEN_PARAM);
  return token && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** One server-sent event: its `event` name (default `message`) and its `data`. */
export interface ServerEvent {
  event: string;
  data: string;
}

/**
 * Split server-sent-event text into complete events; what is left (an event not yet
 * terminated by a blank line) is returned as `rest`, to prepend to the next chunk.
 */
export function parseServerEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: ServerEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

export interface ChangeHandlers {
  change(change: ProjectChange): void;
  /** The server reported a watch failure, or the stream ended or failed. */
  error(message: string): void;
}

export interface LaunchClient {
  launch(): Promise<LaunchInfo>;
  files(): Promise<ProjectSnapshot>;
  /** Follow the change stream until `signal` aborts; resolves when it ends. */
  followChanges(handlers: ChangeHandlers, signal: AbortSignal): Promise<void>;
}

export function createLaunchClient(token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): LaunchClient {
  const headers = { [LAUNCH_TOKEN_HEADER]: token };
  async function getJson<T>(path: string): Promise<T> {
    const response = await fetchImpl(path, { headers });
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }
  return {
    launch: () => getJson<LaunchInfo>(LAUNCH_PATHS.launch),
    files: () => getJson<ProjectSnapshot>(LAUNCH_PATHS.files),
    async followChanges(handlers, signal) {
      try {
        const response = await fetchImpl(LAUNCH_PATHS.changes, { headers, signal });
        if (!response.ok || !response.body) throw new Error(`${LAUNCH_PATHS.changes} answered ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseServerEvents(buffer + value);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            const data = JSON.parse(event.data) as ProjectChange & { message?: string };
            if (event.event === 'error') handlers.error(data.message ?? event.data);
            else handlers.change(data);
          }
        }
        if (!signal.aborted) handlers.error('The change stream ended.');
      } catch (error) {
        if (!signal.aborted) handlers.error(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
