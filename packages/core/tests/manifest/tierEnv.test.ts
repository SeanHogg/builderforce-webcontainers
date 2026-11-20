import { describe, expect, it } from 'vitest';
import { diagnosticsLevel, tierEnv } from '../../src/manifest/index.js';

const prod = { name: 'prod', tier: 'production' as const };
const dev = { name: 'local', tier: 'non-production' as const };
const debug = { name: 'local', tier: 'non-production' as const, debug: true };

describe('tierEnv', () => {
  it('always sets the BUILDERFORCE_* variables', () => {
    expect(tierEnv('unknown-runtime', debug)).toEqual({ BUILDERFORCE_ENV: 'local', BUILDERFORCE_TIER: 'non-production', BUILDERFORCE_DEBUG: 'true' });
    expect(tierEnv('unknown-runtime', prod)).toEqual({ BUILDERFORCE_ENV: 'prod', BUILDERFORCE_TIER: 'production', BUILDERFORCE_DEBUG: 'false' });
  });

  it('never turns debug on for production, even when asked', () => {
    expect(tierEnv('node', { ...prod, debug: true }).BUILDERFORCE_DEBUG).toBe('false');
    expect(tierEnv('php', { ...prod, debug: true }).APP_DEBUG).toBe('false');
  });

  it.each([
    ['node', prod, { NODE_ENV: 'production' }],
    ['node', dev, { NODE_ENV: 'development' }],
    ['php', prod, { APP_ENV: 'production', APP_DEBUG: 'false' }],
    ['php', debug, { APP_ENV: 'local', APP_DEBUG: 'true' }],
    ['dotnet', prod, { ASPNETCORE_ENVIRONMENT: 'Production', DOTNET_ENVIRONMENT: 'Production' }],
    ['dotnet', dev, { ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_ENVIRONMENT: 'Development' }],
    ['python', dev, { FLASK_DEBUG: '0', DJANGO_DEBUG: 'False' }],
    ['python', debug, { FLASK_DEBUG: '1', DJANGO_DEBUG: 'True', PYTHONDEVMODE: '1' }],
    ['rust', dev, { RUST_LOG: 'info' }],
    ['rust', debug, { RUST_LOG: 'debug' }],
  ] as const)('%s in %o sets its conventions', (runtime, env, expected) => {
    const { BUILDERFORCE_ENV, BUILDERFORCE_TIER, BUILDERFORCE_DEBUG, ...conventions } = tierEnv(runtime, env);
    expect(BUILDERFORCE_ENV).toBe(env.name);
    expect(BUILDERFORCE_TIER).toBe(env.tier);
    expect(BUILDERFORCE_DEBUG).toBeDefined();
    expect(conventions).toEqual(expected);
  });
});

describe('diagnosticsLevel', () => {
  it('is off on production, basic on non-production and verbose with debug', () => {
    expect(diagnosticsLevel(prod)).toBe('off');
    expect(diagnosticsLevel({ ...prod, debug: true })).toBe('off');
    expect(diagnosticsLevel(dev)).toBe('basic');
    expect(diagnosticsLevel(debug)).toBe('verbose');
  });
});
