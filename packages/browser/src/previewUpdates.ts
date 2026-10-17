import type { DevServer, FsChange, PreviewUpdate, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';

/** Edits arrive in bursts (a save, an agent writing several files): one update per burst. */
export const UPDATE_DEBOUNCE_MS = 120;

/**
 * Watch the files and tell open previews what each burst of edits means — a
 * style swap, components re-rendered in place, or a reload — as the dev server
 * plans it. Returns the stop function.
 */
export function watchForPreviewUpdates(fs: VirtualFileSystem, server: DevServer, send: (update: PreviewUpdate) => void): () => void {
  let pending: FsChange[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = fs.watch((change) => {
    pending.push(change);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const burst = pending;
      pending = [];
      const update = server.planUpdate(burst);
      if (update) send(update);
    }, UPDATE_DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}
