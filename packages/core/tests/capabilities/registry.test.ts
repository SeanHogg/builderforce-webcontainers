import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES, createCapabilityRegistry, orderCapabilities, type CapabilityDefinition } from '../../src/capabilities/index.js';

const def = (id: string, dependsOn: string[] = []): CapabilityDefinition => ({ id, version: 1, dependsOn, requires: [], configSchema: {} });

describe('capability registry', () => {
  it('throws on a duplicate id', () => {
    expect(() => createCapabilityRegistry([def('a'), def('a')])).toThrow(/twice/);
  });

  it('never matches a prototype key', () => {
    expect(BUILTIN_CAPABILITIES.has('constructor')).toBe(false);
    expect(BUILTIN_CAPABILITIES.ids()).toEqual(['agents']);
  });

  it('orders dependencies first and ignores ids it does not know', () => {
    const registry = createCapabilityRegistry([def('child', ['agents']), def('agents'), def('ui', ['child'])]);
    expect(orderCapabilities(['ui', 'nope', 'agents'], registry)).toEqual({ ok: true, order: ['agents', 'child', 'ui'] });
  });

  it('finds a cycle', () => {
    const registry = createCapabilityRegistry([def('a', ['b']), def('b', ['c']), def('c', ['a'])]);
    expect(orderCapabilities(['a'], registry)).toEqual({ ok: false, cycle: ['a', 'b', 'c', 'a'] });
  });
});
