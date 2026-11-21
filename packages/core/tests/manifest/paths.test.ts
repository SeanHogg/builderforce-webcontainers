import { describe, expect, it } from 'vitest';
import { describeManifestIssue, parseManifest, usableWorkspacePaths, validateManifest, type AppManifest } from '../../src/manifest/index.js';

const manifest = (paths: unknown) => ({ version: 1, services: { api: { runtime: 'node', command: 'node server.js', port: 8000 } }, paths });

describe('manifest paths', () => {
  it('a valid override is kept and raises nothing', () => {
    const parsed = parseManifest(JSON.stringify(manifest({ logs: 'var/logs', diagnostics: '.builderforce/diag' })));
    expect(parsed.issues).toEqual([]);
    expect(parsed.manifest?.paths).toEqual({ logs: 'var/logs', diagnostics: '.builderforce/diag' });
  });

  it('regression: an absolute, "..", empty, non-string or unknown override is a typed warning and is omitted, so the default applies', () => {
    const parsed = parseManifest(JSON.stringify(manifest({ logs: '/tmp/logs', diagnostics: '../outside', methodology: '', extra: 'x' })));
    const byPath = Object.fromEntries(parsed.issues.map((issue) => [issue.path, issue]));
    expect(byPath['paths.logs']).toMatchObject({ code: 'invalid-path', severity: 'warning', value: '/tmp/logs', detail: 'It is absolute.' });
    expect(byPath['paths.diagnostics']).toMatchObject({ code: 'invalid-path', severity: 'warning', value: '../outside' });
    expect(byPath['paths.methodology']).toMatchObject({ code: 'invalid-path', detail: 'It is empty.' });
    expect(byPath['paths.extra']).toMatchObject({ code: 'invalid-value', severity: 'warning' });
    expect(parsed.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(parsed.manifest).not.toBeNull();
    expect(parsed.manifest!.paths).toBeUndefined();
    expect(describeManifestIssue(byPath['paths.logs']!)).toContain('the default is used');
  });

  it('keeps the valid entries beside an invalid one; a non-object paths is a warning', () => {
    const parsed = parseManifest(JSON.stringify(manifest({ logs: 'C:\\logs', methodology: 'docs/method', diagnostics: 3 })));
    expect(parsed.manifest!.paths).toEqual({ methodology: 'docs/method' });
    expect(parsed.issues.map((issue) => issue.path).sort()).toEqual(['paths.diagnostics', 'paths.logs']);
    expect(validateManifest(manifest('logs') as unknown as AppManifest)).toEqual([expect.objectContaining({ code: 'invalid-value', path: 'paths', severity: 'warning' })]);
    expect(usableWorkspacePaths(['logs'])).toEqual({});
    expect(usableWorkspacePaths({ logs: '  var/logs ' })).toEqual({ logs: 'var/logs' });
  });
});
