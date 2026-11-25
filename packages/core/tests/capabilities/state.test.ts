import { describe, expect, it } from 'vitest';
import { APP_MANIFEST_SCHEMA_V1, BUILTIN_CAPABILITIES, STATE_CAPABILITY, STATE_POLICY_DEFAULTS, validateManifest } from '../../src/manifest/index.js';

const validate = (config: unknown) => STATE_CAPABILITY.validateConfig?.(config);

describe('the state capability', () => {
  it('is built in', () => {
    expect(BUILTIN_CAPABILITIES.get('state')).toBe(STATE_CAPABILITY);
  });

  it('accepts an empty config and every allowed strategy', () => {
    expect(validate({})).toEqual([]);
    expect(validate({ source: 'snapshot', tempFiles: 'durable' })).toEqual([]);
  });

  it('refuses an unknown strategy', () => {
    expect(validate({ source: 'git' })).toMatchObject([{ path: 'source' }]);
  });

  it('refuses secrets: they are never snapshotted', () => {
    const issues = validate({ secrets: 'snapshot' });
    expect(issues).toMatchObject([{ path: 'secrets' }]);
    expect(issues?.[0]?.detail).toMatch(/never snapshotted/);
  });

  it('refuses kinds that are not configurable, including prototype keys', () => {
    expect(validate({ processes: 'durable' })).toMatchObject([{ path: 'processes' }]);
    expect(validate({ constructor: 'x' })).toMatchObject([{ path: 'constructor' }]);
  });

  it('refuses a config that is not an object', () => {
    expect(validate(true)).toMatchObject([{ path: '' }]);
    expect(validate([])).toMatchObject([{ path: '' }]);
    expect(validate(null)).toMatchObject([{ path: '' }]);
  });

  it('defaults every kind to its first strategy', () => {
    expect(STATE_POLICY_DEFAULTS).toEqual({ source: 'journal', transcripts: 'durable', checkpoints: 'durable', tempFiles: 'ephemeral' });
  });

  it('is validated inside a manifest', () => {
    expect(validateManifest({ version: 1, capabilities: { state: { source: 'nope' } } })).toMatchObject([{ code: 'invalid-value', path: 'capabilities.state.source' }]);
    expect(validateManifest({ version: 1, capabilities: { state: { source: 'snapshot' } } })).toEqual([]);
  });

  it('is described in the published schema with every other built-in', () => {
    expect(Object.keys(APP_MANIFEST_SCHEMA_V1.properties.capabilities.properties).sort()).toEqual(['agents', 'child-runtimes', 'state']);
  });
});
