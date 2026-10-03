import { describe, expect, it } from 'vitest';
import { compare, maxSatisfying, parseVersion, satisfies, validRange } from '../../src/installer/semver.js';

describe('semver parse/compare', () => {
  it('parses versions, tolerating v/= prefixes and dropping build metadata', () => {
    expect(parseVersion('v1.2.3')?.version).toBe('1.2.3');
    expect(parseVersion('=1.2.3-beta.1+build.5')?.version).toBe('1.2.3-beta.1');
    expect(parseVersion('1.2')).toBeNull();
  });

  it('orders by precedence, prereleases below their release', () => {
    const sorted = ['1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '0.9.9', '2.0.0'];
    expect([...sorted].sort(compare)).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '2.0.0']);
  });
});

describe('semver ranges', () => {
  const cases: Array<[string, string, boolean]> = [
    ['1.2.3', '^1.2.3', true],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.0.9', '^0.0', true],
    ['0.1.0', '^0.0', false],
    ['0.9.0', '^0.x', true],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.0', '~1', true],
    ['1.2.0', '1.2.x', true],
    ['1.3.0', '1.2.x', false],
    ['1.5.0', '1.x', true],
    ['1.5.0', '1', true],
    ['3.0.0', '*', true],
    ['3.0.0', '', true],
    ['3.0.0', 'x', true],
    ['1.2.3', '>=1.2.3 <2', true],
    ['2.0.0', '>=1.2.3 <2', false],
    ['1.5.0', '>= 1.2.3 < 2.0.0', true],
    ['2.0.0', '>1', true],
    ['1.9.9', '>1', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.1.9', '<1.2', true],
    ['1.5.0', '1.2.3 - 2.3.4', true],
    ['2.3.5', '1.2.3 - 2.3.4', false],
    ['2.3.9', '1.2 - 2.3', true],
    ['2.4.0', '1.2 - 2.3', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['2.1.0', '^1.0.0 || ^3.0.0', false],
    ['1.2.3', '=1.2.3', true],
    ['1.2.4', '1.2.3', false],
    // Prereleases only match a range naming one on the same tuple.
    ['1.2.4-beta.1', '^1.2.3', false],
    ['1.2.3-beta.4', '^1.2.3-beta.2', true],
    ['1.2.4-beta.1', '^1.2.3-beta.2', false],
    ['2.0.0-alpha', '^1.0.0', false],
    ['1.0.0-rc.1', '*', false],
  ];
  it.each(cases)('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('rejects tags and garbage as ranges', () => {
    expect(validRange('latest')).toBe(false);
    expect(validRange('^1.2.3 || ~2')).toBe(true);
    expect(satisfies('1.0.0', 'latest')).toBe(false);
  });

  it('picks the highest satisfying version', () => {
    const versions = ['1.0.0', '1.4.2', '1.10.0', '2.0.0', '2.1.0-beta.1'];
    expect(maxSatisfying(versions, '^1.0.0')).toBe('1.10.0');
    expect(maxSatisfying(versions, '>=2')).toBe('2.0.0');
    expect(maxSatisfying(versions, '^3')).toBeNull();
  });
});
