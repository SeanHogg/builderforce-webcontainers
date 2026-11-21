/**
 * `dotnet run`'s launch profiles: `Properties/launchSettings.json` beside the
 * project. The named profile (`--launch-profile`), else the first whose
 * `commandName` is `Project`, gives the program its environment variables,
 * its `applicationUrl` (as ASPNETCORE_URLS — unless the process already has
 * ASPNETCORE_URLS, as a service whose port the application runtime assigned
 * does) and its `commandLineArgs` (before the command line's own).
 */
import { join } from '@seanhogg/builderforce-webcontainers-core';

export interface LaunchProfile {
  name: string;
  env: Record<string, string>;
  args: string[];
}

export type LaunchResult = { ok: true; profile?: LaunchProfile } | { ok: false; reason: string };

interface ProfileJson {
  commandName?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, unknown>;
  commandLineArgs?: string;
}

/**
 * Split `commandLineArgs` as a shell would (quotes group, no expansion). Not core's `splitCommandLine`:
 * launchSettings.json is Windows-authored, so a backslash here is a path separator and stays literal.
 */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** The profile for a `dotnet run` (`name` undefined: the default; null: `--no-launch-profile`). */
export function readLaunchProfile(read: (path: string) => string | undefined, projectDir: string, name: string | null | undefined, env: Record<string, string>): LaunchResult {
  if (name === null) return { ok: true };
  const path = join(projectDir, 'Properties', 'launchSettings.json');
  const text = read(path);
  if (text === undefined) return name ? { ok: false, reason: `The launch profile "${name}" could not be applied: ${path} does not exist.` } : { ok: true };
  let profiles: Record<string, ProfileJson>;
  try {
    profiles = (JSON.parse(text) as { profiles?: Record<string, ProfileJson> }).profiles ?? {};
  } catch (error) {
    return { ok: false, reason: `A JSON parsing exception occurred in ${path}: ${(error as Error).message}` };
  }
  const entry = name ? Object.entries(profiles).find(([key]) => key === name) : Object.entries(profiles).find(([, profile]) => profile.commandName === 'Project');
  if (!entry) return name ? { ok: false, reason: `The launch profile "${name}" could not be applied: it is not in ${path}.` } : { ok: true };
  const [profileName, profile] = entry;
  const profileEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.environmentVariables ?? {})) profileEnv[key] = String(value);
  if (profile.applicationUrl && env.ASPNETCORE_URLS === undefined && profileEnv.ASPNETCORE_URLS === undefined) profileEnv.ASPNETCORE_URLS = profile.applicationUrl;
  return { ok: true, profile: { name: profileName, env: profileEnv, args: profile.commandLineArgs ? splitArgs(profile.commandLineArgs) : [] } };
}
