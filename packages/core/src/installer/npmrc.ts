/**
 * `.npmrc`: the default registry, per-scope registries (`@acme:registry=…`) and
 * auth tokens keyed by registry path (`//npm.acme.dev/:_authToken=${NPM_TOKEN}`).
 * Project and user files are read like npm does — the project's wins — and
 * `${VAR}` is filled from the process environment.
 *
 * A private registry is reached with the browser's `fetch`, so it must answer
 * CORS requests that carry an `Authorization` header.
 */
import type { VirtualFileSystem } from '../vfs.js';

export interface NpmConfig {
  registry?: string;
  /** `@scope` → registry URL. */
  scopes: Record<string, string>;
  /** `//host/path/` → bearer token. */
  tokens: Record<string, string>;
}

export function emptyNpmConfig(): NpmConfig {
  return { scopes: {}, tokens: {} };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function parseNpmrc(text: string, env: Record<string, string | undefined> = {}, into: NpmConfig = emptyNpmConfig()): NpmConfig {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\$\{([^}]+)\}/g, (_m, name: string) => env[name] ?? '');
    if (key === 'registry') into.registry = trimSlash(value);
    else if (/^@[^:]+:registry$/.test(key)) into.scopes[key.slice(0, key.indexOf(':'))] = trimSlash(value);
    else if (key.startsWith('//') && key.endsWith(':_authToken')) into.tokens[key.slice(0, -':_authToken'.length).replace(/\/?$/, '/')] = value;
  }
  return into;
}

/** Read `.npmrc` files, lowest precedence first (user, then project). Missing files are skipped. */
export function readNpmConfig(fs: VirtualFileSystem, paths: string[], env: Record<string, string | undefined> = {}): NpmConfig {
  const config = emptyNpmConfig();
  for (const path of paths) {
    const text = fs.readText(path);
    if (text !== undefined) parseNpmrc(text, env, config);
  }
  return config;
}

/** The registry a package is fetched from: its scope's, else the default. */
export function registryFor(config: NpmConfig | undefined, name: string, fallback: string): string {
  if (name.startsWith('@')) {
    const scoped = config?.scopes[name.slice(0, name.indexOf('/'))];
    if (scoped) return scoped;
  }
  return fallback;
}

/** `Authorization` for a URL: the token whose registry path is the longest prefix of it. */
export function authHeaders(config: NpmConfig | undefined, url: string): Record<string, string> {
  if (!config) return {};
  const target = url.replace(/^https?:/, '');
  let best = '';
  for (const prefix of Object.keys(config.tokens)) {
    if ((target.startsWith(prefix) || target + '/' === prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? { authorization: `Bearer ${config.tokens[best]}` } : {};
}
