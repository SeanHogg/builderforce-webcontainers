/**
 * The .NET Worker kind and the host's instructions to it. Until the process
 * protocol declares them (node/protocol.ts: `WorkerKind` gains `'dotnet'`,
 * `StartMessage` gains `dotnet?: DotnetStartOptions`), they are declared here
 * and the start message is read through {@link dotnetStartOptionsOf}.
 */
import type { StartMessage } from '../../node/protocol.js';

/** The Worker kind .NET processes run in. */
export const DOTNET_WORKER_KIND = 'dotnet' as const;

/**
 * Host-only settings for .NET processes: a program's environment can change
 * none of them.
 */
export interface DotnetStartOptions {
  /**
   * Where the .NET runtime bundle (scripts/build-dotnet-runtime.mjs) is served:
   * absolute, CORS-enabled; in relay mode, reachable from the preview origin.
   * There is no default — the bundle is the host's artifact.
   */
  bundleUrl?: string;
}

/** A start message as a .NET process receives it. */
export type DotnetStartMessage = StartMessage & { dotnet?: DotnetStartOptions };

export const dotnetStartOptionsOf = (message: StartMessage): DotnetStartOptions | undefined => (message as DotnetStartMessage).dotnet;
