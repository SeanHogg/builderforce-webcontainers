import { describe, expect, it } from 'vitest';
import { describeManifestIssue, parseManifest } from '../../src/manifest/index.js';
import { DESIGN_EXAMPLE_JSON } from './fixtures.js';

describe('parseManifest', () => {
  it('reads the design example as a v1 manifest with zero issues', () => {
    const result = parseManifest(DESIGN_EXAMPLE_JSON);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.name).toBe('acme-shop');
    expect(Object.keys(result.manifest?.services ?? {})).toEqual(['api', 'worker', 'web']);
    expect(result.legacy).toBeUndefined();
  });

  it('accepts a byte-order mark', () => {
    expect(parseManifest(`﻿{"version":1}`).manifest).toEqual({ version: 1 });
  });

  it('reports invalid JSON with the parser message, never a silent null', () => {
    const result = parseManifest('{ "version": 1, ');
    expect(result.manifest).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'invalid-json', severity: 'error', path: '' });
    expect(result.issues[0]!.detail).toBeTruthy();
    expect(describeManifestIssue(result.issues[0]!)).toContain('not valid JSON');
  });

  it('reports JSON that is not an object', () => {
    expect(parseManifest('[1,2]').issues[0]?.code).toBe('not-an-object');
  });

  it('flags an unversioned file as legacy and hands the parsed object back uninterpreted', () => {
    const legacy = { services: [{ id: 'web', runtime: 'node' }], database: { engine: 'postgres' } };
    const result = parseManifest(JSON.stringify(legacy));
    expect(result.manifest).toBeNull();
    expect(result.legacy).toEqual(legacy);
    expect(result.issues).toEqual([{ code: 'legacy-format', severity: 'info', path: 'version' }]);
  });

  it('refuses a version other than 1', () => {
    const result = parseManifest('{"version": 2}');
    expect(result.manifest).toBeNull();
    expect(result.issues[0]).toMatchObject({ code: 'unsupported-version', value: '2', severity: 'error' });
  });

  it('returns a v1 manifest with its validation issues so a host can show them per key', () => {
    const result = parseManifest('{"version":1,"services":{"api":{"runtime":"node","command":"x","port":99999}}}');
    expect(result.manifest).not.toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'invalid-port', path: 'services.api.port' })]);
  });
});
