/**
 * The .NET Worker kind and the host's instructions to it. The instructions are
 * declared with the process protocol (node/protocol.ts: `StartMessage.dotnet`),
 * beside Python's and PHP's; re-exported here for the .NET runtime's API.
 */
import type { WorkerKind } from '../../node/protocol.js';

export type { DotnetStartOptions } from '../../node/protocol.js';

/** The Worker kind .NET processes run in — the one constant for it. */
export const DOTNET_KIND = 'dotnet' satisfies WorkerKind;
