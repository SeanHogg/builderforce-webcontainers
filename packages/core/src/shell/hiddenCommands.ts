/**
 * Shell commands that are deliberately undocumented: dispatched by the executor,
 * but absent from `help`, tab completion, `type` and `which`.
 *
 * `bfwc-badge off|on|status` toggles the preview's "Built with Builderforce.ai"
 * badge through {@link ATTRIBUTION_OFF_MARKER}, which the browser host checks on
 * every page it serves. Paths are absolute, so it works from any directory.
 * It is an internal maintainer toggle, not a supported API: hosts turn the badge
 * off with the `attribution: false` option (README › Attribution), which wins
 * over the marker.
 */
import { ATTRIBUTION_OFF_MARKER } from '../attribution.js';
import { dirname } from '../paths.js';
import type { Builtin } from './builtins.js';

const BADGE_USAGE = 'usage: bfwc-badge [off|on|status]\n';

const bfwcBadge: Builtin = async (ctx) => {
  const { fs, io } = ctx;
  const action = ctx.args[0] ?? 'status';
  if (ctx.args.length > 1 || !['off', 'on', 'status'].includes(action)) {
    io.stderr(BADGE_USAGE);
    return 2;
  }
  if (action === 'off') {
    fs.mkdir(dirname(ATTRIBUTION_OFF_MARKER));
    fs.writeFile(ATTRIBUTION_OFF_MARKER, '');
    io.stdout('Preview badge off. Reload the preview to apply.\n');
  } else if (action === 'on') {
    fs.rm(ATTRIBUTION_OFF_MARKER);
    const dir = dirname(ATTRIBUTION_OFF_MARKER);
    if (fs.isDirectory(dir) && fs.readdir(dir).length === 0) fs.rm(dir);
    io.stdout('Preview badge on. Reload the preview to apply.\n');
  } else {
    io.stdout(fs.isFile(ATTRIBUTION_OFF_MARKER) ? 'off\n' : 'on\n');
  }
  return 0;
};

export const HIDDEN_BUILTINS: Record<string, Builtin> = {
  'bfwc-badge': bfwcBadge,
};
