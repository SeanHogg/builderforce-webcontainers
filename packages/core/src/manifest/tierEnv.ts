/**
 * What an environment's tier and debug flag mean to each runtime's frameworks,
 * and how much diagnostics it may expose. These are the ONLY places this is
 * decided: every producer, transport and surface asks `diagnosticsLevel`, and
 * every service's environment gets `tierEnv` (below its own `env`).
 */
import type { EnvironmentTier } from './types.js';

export interface TierContext {
  /** The environment's name: `local`, `staging`, `prod`. */
  name: string;
  tier: EnvironmentTier;
  /** Honoured on non-production only. */
  debug?: boolean;
}

/** How a runtime's conventions read the environment: production, development, or development with debug. */
export type TierMode = 'production' | 'development' | 'debug';

/** One convention variable's value in each mode; an absent value leaves it unset. */
export interface TierVariable {
  readonly name: string;
  readonly values: Readonly<Partial<Record<TierMode, string>>>;
}

/** The framework conventions per runtime id. A runtime not listed gets only the `BUILDERFORCE_*` variables. */
export const TIER_ENV_CONVENTIONS: Readonly<Record<string, readonly TierVariable[]>> = {
  node: [{ name: 'NODE_ENV', values: { production: 'production', development: 'development', debug: 'development' } }],
  php: [
    { name: 'APP_ENV', values: { production: 'production', development: 'local', debug: 'local' } },
    { name: 'APP_DEBUG', values: { production: 'false', development: 'false', debug: 'true' } },
  ],
  dotnet: [
    { name: 'ASPNETCORE_ENVIRONMENT', values: { production: 'Production', development: 'Development', debug: 'Development' } },
    { name: 'DOTNET_ENVIRONMENT', values: { production: 'Production', development: 'Development', debug: 'Development' } },
  ],
  python: [
    { name: 'FLASK_DEBUG', values: { production: '0', development: '0', debug: '1' } },
    { name: 'DJANGO_DEBUG', values: { production: 'False', development: 'False', debug: 'True' } },
    { name: 'PYTHONDEVMODE', values: { debug: '1' } },
  ],
  rust: [{ name: 'RUST_LOG', values: { production: 'info', development: 'info', debug: 'debug' } }],
};

/** Debug counts only on non-production. */
export function isDebug(env: Pick<TierContext, 'tier' | 'debug'>): boolean {
  return env.tier === 'non-production' && env.debug === true;
}

export function tierMode(env: Pick<TierContext, 'tier' | 'debug'>): TierMode {
  if (env.tier === 'production') return 'production';
  return isDebug(env) ? 'debug' : 'development';
}

/** The tier variables one service of `runtime` starts with in `env`. */
export function tierEnv(runtime: string, env: TierContext): Record<string, string> {
  const mode = tierMode(env);
  const result: Record<string, string> = {
    BUILDERFORCE_ENV: env.name,
    BUILDERFORCE_TIER: env.tier,
    BUILDERFORCE_DEBUG: String(isDebug(env)),
  };
  for (const variable of TIER_ENV_CONVENTIONS[runtime] ?? []) {
    const value = variable.values[mode];
    if (value !== undefined) result[variable.name] = value;
  }
  return result;
}

export type DiagnosticsLevel = 'off' | 'basic' | 'verbose';

/** The one diagnostics gate: production `off`, non-production `basic`, non-production with debug `verbose`. */
export function diagnosticsLevel(env: Pick<TierContext, 'tier' | 'debug'>): DiagnosticsLevel {
  if (env.tier !== 'non-production') return 'off';
  return isDebug(env) ? 'verbose' : 'basic';
}
