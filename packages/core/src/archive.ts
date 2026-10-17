/**
 * The file system as a zip: one format for "Download project" and for a
 * snapshot a host stores and restores later (with `node_modules`, so a
 * restored project needs no reinstall). Empty directories created with `mkdir`
 * travel as `name/` entries; text comes back as strings, everything else as bytes.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { VirtualFileSystem } from './vfs.js';
import { join } from './paths.js';

export interface ZipExportOptions {
  /** Path prefixes left out (`node_modules`, `dist`), relative to the root, no leading slash. */
  exclude?: string[];
  /** 0 (store, fastest) to 9. Default 6. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function excluded(relative: string, exclude: string[]): boolean {
  return exclude.some((prefix) => {
    const clean = prefix.replace(/^\/+|\/+$/g, '');
    return relative === clean || relative.startsWith(clean + '/');
  });
}

export function exportZip(fs: VirtualFileSystem, options: ZipExportOptions = {}): Uint8Array {
  const exclude = options.exclude ?? [];
  const entries: Zippable = {};
  for (const dir of fs.explicitDirectories()) {
    const relative = dir.slice(1);
    if (!excluded(relative, exclude) && fs.readdir(dir).length === 0) entries[relative + '/'] = new Uint8Array(0);
  }
  for (const path of fs.list()) {
    const relative = path.slice(1);
    if (excluded(relative, exclude)) continue;
    const contents = fs.readFile(path)!;
    entries[relative] = typeof contents === 'string' ? encoder.encode(contents) : contents;
  }
  return zipSync(entries, { level: options.level ?? 6 });
}

/** Write a zip's contents into `fs` under `at` (default `/`), over whatever is there. */
export function importZip(fs: VirtualFileSystem, zip: Uint8Array, at = '/'): void {
  for (const [name, bytes] of Object.entries(unzipSync(zip))) {
    if (name.endsWith('/')) {
      fs.mkdir(join(at, name.slice(0, -1)));
      continue;
    }
    let contents: string | Uint8Array = bytes;
    try {
      contents = strictUtf8.decode(bytes);
    } catch {
      // binary: keep the bytes
    }
    fs.writeFile(join(at, name), contents);
  }
}
