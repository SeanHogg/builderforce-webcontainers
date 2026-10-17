import { describe, expect, it } from 'vitest';
import { CookieJar, PortCookieJars, cookiePathMatches, defaultCookiePath, parseSetCookie } from '../../src/system/cookieJar.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

describe('parseSetCookie', () => {
  it('reads the pair and attributes, defaulting the path to the request directory', () => {
    expect(parseSetCookie('sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax', '/login', NOW)).toEqual({
      name: 'sid',
      value: 'abc',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      deleted: false,
    });
    expect(parseSetCookie('a=1', '/api/v1/items', NOW)?.path).toBe('/api/v1');
    expect(parseSetCookie('a=1', '/top', NOW)?.path).toBe('/');
    expect(parseSetCookie('no-equals-sign', '/', NOW)).toBeUndefined();
    expect(parseSetCookie('=value', '/', NOW)).toBeUndefined();
  });

  it('lets Max-Age win over Expires and marks past expiry as a deletion', () => {
    expect(parseSetCookie('a=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT', '/', NOW)).toMatchObject({ expires: NOW + 60_000, deleted: false });
    expect(parseSetCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', '/', NOW)?.deleted).toBe(true);
    expect(parseSetCookie('a=; Max-Age=0', '/', NOW)?.deleted).toBe(true);
  });
});

describe('cookie paths', () => {
  it('matches RFC 6265 path prefixes', () => {
    expect(defaultCookiePath('/a/b?x=1')).toBe('/a');
    expect(cookiePathMatches('/', '/anything')).toBe(true);
    expect(cookiePathMatches('/api', '/api')).toBe(true);
    expect(cookiePathMatches('/api', '/api/users?x')).toBe(true);
    expect(cookiePathMatches('/api', '/apikeys')).toBe(false);
    expect(cookiePathMatches('/api/', '/api/x')).toBe(true);
  });
});

describe('CookieJar', () => {
  it('stores Set-Cookie and builds the Cookie header for matching paths, longest path first', () => {
    const jar = new CookieJar();
    expect(jar.store(['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/', 'scope=admin; Path=/admin'], '/login', NOW)).toBe(true);
    expect(jar.header('/', NOW)).toBe('sid=abc; theme=dark');
    expect(jar.header('/admin/users', NOW)).toBe('scope=admin; sid=abc; theme=dark');
    expect(jar.header('/administrator', NOW)).toBe('sid=abc; theme=dark');
  });

  it('keeps HttpOnly cookies out of document.cookie and away from page script', () => {
    const jar = new CookieJar();
    jar.store('sid=abc; Path=/; HttpOnly', '/', NOW);
    jar.store('theme=dark; Path=/', '/', NOW);
    expect(jar.documentCookie('/', NOW)).toBe('theme=dark');
    expect(jar.setFromDocument('sid=stolen; path=/', '/', NOW)).toBe(false); // cannot replace an HttpOnly cookie
    expect(jar.setFromDocument('x=1; HttpOnly', '/', NOW)).toBe(false); // nor create one
    expect(jar.setFromDocument('lang=en; path=/', '/page', NOW)).toBe(true);
    expect(jar.header('/', NOW)).toBe('sid=abc; theme=dark; lang=en');
  });

  it('replaces by name and path, deletes on Max-Age=0, and forgets expired cookies', () => {
    const jar = new CookieJar();
    jar.store('a=1; Path=/', '/', NOW);
    jar.store('a=2; Path=/', '/', NOW);
    jar.store('b=1; Max-Age=10', '/', NOW);
    expect(jar.header('/', NOW)).toBe('a=2; b=1');
    expect(jar.header('/', NOW + 11_000)).toBe('a=2');
    jar.store('a=; Path=/; Max-Age=0', '/', NOW);
    expect(jar.header('/', NOW)).toBeUndefined();
    expect(jar.list(NOW)).toEqual([]);
  });

  it('reports changes, and only real ones', () => {
    const jar = new CookieJar();
    let changes = 0;
    jar.onChange(() => changes++);
    jar.store('a=1', '/', NOW);
    jar.store('a=1', '/', NOW);
    jar.store([], '/', NOW);
    jar.store(undefined, '/', NOW);
    expect(changes).toBe(1);
    jar.clear();
    expect(changes).toBe(2);
  });
});

describe('PortCookieJars', () => {
  it('keeps one jar per port and says which changed', () => {
    const jars = new PortCookieJars();
    const changed: number[] = [];
    jars.onChange((port) => changed.push(port));
    jars.jar(3000).store('a=1', '/', NOW);
    jars.jar(4000).store('b=2', '/', NOW);
    expect(jars.jar(3000).header('/', NOW)).toBe('a=1');
    expect(jars.jar(4000).header('/', NOW)).toBe('b=2');
    expect(changed).toEqual([3000, 4000]);
  });
});
