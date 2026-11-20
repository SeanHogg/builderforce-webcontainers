import { describe, expect, it } from 'vitest';
import { mergeOverrides, resolveEnvironment, validateManifest, type AppManifest } from '../../src/manifest/index.js';
import { reactNodePostgres } from './fixtures.js';

describe('resolveEnvironment', () => {
  it('merges an environment override deep and per key, leaving everything else as it was', () => {
    const manifest = reactNodePostgres();
    manifest.services!.api!.scale = { min: 1, max: 4, metric: 'concurrency' };
    const { manifest: resolved, environment, issues } = resolveEnvironment(manifest, 'prod');
    expect(issues).toEqual([]);
    expect(environment).toMatchObject({ name: 'prod', target: 'aws', tier: 'production' });
    expect(resolved!.services!.api!.scale).toEqual({ min: 2, max: 4, metric: 'concurrency' });
    expect(resolved!.services!.api!.command).toBe('npm start');
    expect(resolved!.services!.web).toEqual(manifest.services!.web);
    // The base is untouched.
    expect(manifest.services!.api!.scale!.min).toBe(1);
  });

  it('replaces an array as one value, never the whole list of entries', () => {
    const manifest = reactNodePostgres();
    manifest.environments!.local!.overrides = { services: { api: { args: ['--inspect'] } }, resources: { db: { persistent: false } } };
    const { manifest: resolved } = resolveEnvironment(manifest, 'local');
    expect(resolved!.services!.api!.args).toEqual(['--inspect']);
    expect(resolved!.services!.api!.uses).toEqual(['db']);
    expect(Object.keys(resolved!.services!)).toEqual(['api', 'web']);
    expect(resolved!.resources!.db).toEqual({ type: 'postgres', persistent: false });
  });

  it('reports an unknown environment', () => {
    const result = resolveEnvironment(reactNodePostgres(), 'qa');
    expect(result.manifest).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'unknown-environment', value: 'qa' })]);
  });

  it('reports and skips an override of an entry the base lacks', () => {
    const manifest = reactNodePostgres();
    manifest.environments!.local!.overrides = { services: { ghost: { port: 1 } } };
    const result = resolveEnvironment(manifest, 'local');
    expect(result.issues).toEqual([expect.objectContaining({ code: 'unknown-override-entry', value: 'ghost' })]);
    expect(result.manifest!.services!.ghost).toBeUndefined();
  });

  it('defaults to a browser, non-production `local` environment when none is declared', () => {
    const manifest: AppManifest = { version: 1, services: { api: { runtime: 'node', command: 'npm start' } } };
    expect(resolveEnvironment(manifest, 'local').environment).toEqual({ name: 'local', target: 'browser', tier: 'non-production' });
  });
});

describe('mergeOverrides', () => {
  it('merges objects per key and replaces everything else', () => {
    expect(mergeOverrides({ a: { b: 1, c: [1, 2] }, d: 'x' }, { a: { c: [3] }, e: 1 })).toEqual({ a: { b: 1, c: [3] }, d: 'x', e: 1 });
    expect(mergeOverrides({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('never copies a prototype key from parsed JSON', () => {
    const patch: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"a":{"__proto__":{"polluted":true},"b":2}}');
    const merged = mergeOverrides({ a: { b: 1 } } as Record<string, unknown>, patch);
    expect(merged).toEqual({ a: { b: 2 } });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(merged.a)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('overrides and prototype keys', () => {
  it('treats `constructor`/`__proto__` override entries as unknown, never as the base’s prototype', () => {
    const manifest = reactNodePostgres();
    manifest.environments!.local!.overrides = JSON.parse('{"services":{"constructor":{"port":1},"__proto__":{"port":2},"toString":{"port":3}}}');
    const result = resolveEnvironment(manifest, 'local');
    expect(result.issues.map((issue) => issue.value).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.keys(result.manifest!.services!)).toEqual(['api', 'web']);
    expect(Object.getPrototypeOf(result.manifest!.services)).toBe(Object.prototype);
  });

  it('refuses a prototype key as an id and resolves references by own keys only', () => {
    const manifest = JSON.parse(
      '{"version":1,"services":{"constructor":{"runtime":"node","command":"x"},"api":{"runtime":"node","command":"npm start","uses":["toString"],"dependsOn":["hasOwnProperty"]}}}',
    ) as AppManifest;
    const codes = validateManifest(manifest).map((issue) => `${issue.code}:${issue.value ?? ''}`);
    expect(codes).toContain('invalid-id:constructor');
    expect(codes).toContain('unknown-resource:toString');
    expect(codes).toContain('unknown-service:hasOwnProperty');
  });
});
