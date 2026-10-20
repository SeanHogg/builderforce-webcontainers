/**
 * What a preview reports to the host page: uncaught errors and console output,
 * posted by the bridge script every served page starts with. One window
 * listener per runtime, accepting only messages from the preview origin whose
 * page sits under this runtime's base, so two runtimes on one page never hear
 * each other's previews. A runtime with a nonce (startPreviewRuntime makes one)
 * also requires it on every message: the bridge it injects carries it, so a
 * frame on the preview origin cannot claim another runtime's base by `href`.
 */
import { CONSOLE_MESSAGE_TYPE, ERROR_MESSAGE_TYPE } from '@seanhogg/builderforce-webcontainers-core';

export interface PreviewError {
  message: string;
  stack?: string;
  href: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface PreviewConsoleMessage {
  level: ConsoleLevel;
  /** The arguments flattened to text, capped at 4,000 characters. */
  text: string;
  href: string;
}

export interface PreviewMessages {
  onError(listener: (error: PreviewError) => void): () => void;
  onConsole(listener: (message: PreviewConsoleMessage) => void): () => void;
  dispose(): void;
}

const LEVELS = new Set<string>(['log', 'info', 'warn', 'error', 'debug']);

/**
 * The preview page a window message came from, when it is one of THIS runtime's:
 * sent from the preview origin, by a page under `base`, carrying `nonce` when
 * the runtime has one. Undefined otherwise.
 */
export function previewPageOf(event: MessageEvent, origin: string, base: string, nonce?: string): URL | undefined {
  const data = event.data as { href?: unknown; nonce?: unknown } | null;
  const href = data?.href;
  if (typeof href !== 'string' || event.origin !== origin) return undefined;
  if (nonce !== undefined && data!.nonce !== nonce) return undefined;
  try {
    const page = new URL(href);
    return page.pathname.startsWith(base) ? page : undefined; // else: another runtime's preview
  } catch {
    return undefined;
  }
}

function subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

export function listenToPreview(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, origin: string, base: string, nonce?: string): PreviewMessages {
  const errors = new Set<(error: PreviewError) => void>();
  const consoles = new Set<(message: PreviewConsoleMessage) => void>();

  const onMessage = (event: MessageEvent) => {
    if (!previewPageOf(event, origin, base, nonce)) return;
    const data = event.data as { type?: unknown; href: string; message?: unknown; stack?: unknown; level?: unknown; text?: unknown };
    if (data.type === ERROR_MESSAGE_TYPE) {
      const error: PreviewError = { message: String(data.message ?? ''), stack: typeof data.stack === 'string' ? data.stack : undefined, href: data.href };
      for (const listener of errors) listener(error);
    } else if (data.type === CONSOLE_MESSAGE_TYPE && typeof data.level === 'string' && LEVELS.has(data.level)) {
      const message: PreviewConsoleMessage = { level: data.level as ConsoleLevel, text: String(data.text ?? ''), href: data.href };
      for (const listener of consoles) listener(message);
    }
  };
  target.addEventListener('message', onMessage as EventListener);

  return {
    onError: (listener) => subscribe(errors, listener),
    onConsole: (listener) => subscribe(consoles, listener),
    dispose() {
      target.removeEventListener('message', onMessage as EventListener);
      errors.clear();
      consoles.clear();
    },
  };
}
