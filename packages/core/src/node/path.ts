/**
 * Node's `path` module, POSIX flavour — the runtime reports `platform: 'linux'`,
 * so `path.win32` is the same object (Windows paths never occur in the VFS).
 * `resolve` needs a cwd, so the module is created per process.
 */

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

function normalizeString(path: string, allowAboveRoot: boolean): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
    } else out.push(segment);
  }
  return out.join('/');
}

export function createPathModule(cwd: () => string) {
  const assertPath = (p: unknown) => {
    if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
  };

  const path = {
    sep: '/',
    delimiter: ':',

    normalize(p: string): string {
      assertPath(p);
      if (!p) return '.';
      const absolute = p.startsWith('/');
      const trailing = p.endsWith('/');
      let out = normalizeString(p, !absolute);
      if (!out && !absolute) out = '.';
      if (out && trailing) out += '/';
      return absolute ? '/' + out : out;
    },

    join(...parts: string[]): string {
      parts.forEach(assertPath);
      const joined = parts.filter(Boolean).join('/');
      return joined ? path.normalize(joined) : '.';
    },

    resolve(...parts: string[]): string {
      let resolved = '';
      for (let i = parts.length - 1; i >= -1 && !resolved.startsWith('/'); i--) {
        const part = i >= 0 ? parts[i]! : cwd();
        assertPath(part);
        if (part) resolved = resolved ? `${part}/${resolved}` : part;
      }
      const out = normalizeString(resolved, false);
      return '/' + out;
    },

    isAbsolute(p: string): boolean {
      assertPath(p);
      return p.startsWith('/');
    },

    relative(from: string, to: string): string {
      const a = path.resolve(from).split('/').filter(Boolean);
      const b = path.resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
    },

    dirname(p: string): string {
      assertPath(p);
      if (!p) return '.';
      const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
      const cut = trimmed.lastIndexOf('/');
      if (cut < 0) return '.';
      if (cut === 0) return '/';
      return trimmed.slice(0, cut);
    },

    basename(p: string, ext?: string): string {
      assertPath(p);
      const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
      let base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
      if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
      return base;
    },

    extname(p: string): string {
      const base = path.basename(p);
      const dot = base.lastIndexOf('.');
      return dot <= 0 ? '' : base.slice(dot);
    },

    parse(p: string): ParsedPath {
      const root = p.startsWith('/') ? '/' : '';
      const base = path.basename(p);
      const ext = path.extname(p);
      const dirname = path.dirname(p);
      const dir = dirname === '.' && !p.includes('/') ? '' : dirname;
      return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },

    format(parts: Partial<ParsedPath>): string {
      const dir = parts.dir ?? parts.root ?? '';
      const base = parts.base ?? `${parts.name ?? ''}${parts.ext ?? ''}`;
      if (!dir) return base;
      return dir === parts.root ? `${dir}${base}` : `${dir}/${base}`;
    },

    toNamespacedPath(p: string): string {
      return p;
    },

    matchesGlob(p: string, pattern: string): boolean {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '(?:.*/)?');
      return new RegExp(`^${source}$`).test(p);
    },
  } as Record<string, any>;

  path.posix = path;
  path.win32 = path;
  return path;
}
