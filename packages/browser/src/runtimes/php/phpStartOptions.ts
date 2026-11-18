/**
 * The PHP Worker kind and the host's instructions to it. The instructions are
 * declared with the process protocol (node/protocol.ts: `StartMessage.php`),
 * beside Python's; re-exported here for the PHP runtime's API.
 */
import type { WorkerKind } from '../../node/protocol.js';

export type { ComposerSourceOptions, PhpStartOptions } from '../../node/protocol.js';

/** The Worker kind PHP processes run in — the one constant for it. */
export const PHP_KIND = 'php' satisfies WorkerKind;
