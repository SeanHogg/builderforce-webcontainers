import { REFRESH_GLOBAL } from './reactRefresh.js';

/**
 * What the host tells open previews after an edit. Old pages reload on any
 * message, and new pages treat anything that is not an `update` as a reload,
 * so a host and a preview from different releases still agree.
 */
export type PreviewUpdate = { type: 'reload' } | HotUpdate;

export interface HotUpdate {
  type: 'update';
  /** Stylesheets to swap without reloading. */
  styles: HotStyle[];
  /** Module URLs (fresh stamps) to re-run, then let React Refresh re-render. */
  modules: string[];
}

export interface HotStyle {
  /** The stylesheet's URL path, as a `<link href>` names it. */
  path: string;
  /** Its JS module URL with a fresh stamp, for a stylesheet imported from JS. */
  url: string;
  stamp: number;
}

/** The BroadcastChannel previews of `base` listen on — keyed, so two runtimes never cross. */
export function updateChannelName(base: string): string {
  return `bfwc:reload:${base}`;
}

/**
 * Runs in every preview page. A stylesheet `<link>` gets a cache-busted `href`;
 * one imported from JS is re-imported, which replaces its <style> tag. Changed
 * modules are re-imported in order, then React Refresh re-renders what they
 * define. An update that fails to apply (a syntax error mid-edit) is reported
 * as an uncaught error and leaves the page as it was; the next edit applies on top.
 */
export function hotUpdateScript(base: string): string {
  return `<script>(function(){
  if (typeof BroadcastChannel === 'undefined') return;
  var pending = Promise.resolve();
  function swapStyle(style) {
    var swapped = false;
    document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
      var url = new URL(link.href, location.href);
      if (url.pathname !== style.path) return;
      url.searchParams.set('t', String(style.stamp));
      link.href = url.href;
      swapped = true;
    });
    return swapped ? undefined : import(style.url);
  }
  function apply(update) {
    return Promise.all(update.styles.map(swapStyle)).then(function () {
      if (!update.modules.length) return;
      var refresh = window[${JSON.stringify(REFRESH_GLOBAL)}];
      if (!refresh) return location.reload();
      return update.modules.reduce(function (chain, url) { return chain.then(function () { return import(url); }); }, Promise.resolve())
        .then(function () { refresh.performReactRefresh(); });
    });
  }
  new BroadcastChannel(${JSON.stringify(updateChannelName(base))}).onmessage = function (event) {
    var update = event.data;
    if (!update || update.type !== 'update') return location.reload();
    pending = pending.then(function () { return apply(update); }).catch(function (error) {
      setTimeout(function () { throw error; });
    });
  };
})();</script>`;
}
