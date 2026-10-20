/**
 * The file system as a zip: one format for "Download project" and for a
 * snapshot a host stores and restores later (with `node_modules`, so a
 * restored project needs no reinstall). Empty directories created with `mkdir`
 * travel as `name/` entries; text comes back as strings, everything else as bytes.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { VirtualFileSystem } from './vfs.js';
import { projectToBase } from './rootedFs.js';

export interface ZipExportOptions {
  /** Only these path prefixes (`node_modules`), relative to the root, no leading slash. Default: everything. */
  include?: string[];
  /** Path prefixes left out (`node_modules`, `dist`), relative to the root, no leading slash. */
  exclude?: string[];
  /** 0 (store, fastest) to 9. Default 6. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function under(relative: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+|\/+$/g, '');
    return relative === clean || relative.startsWith(clean + '/');
  });
}

export function exportZip(fs: VirtualFileSystem, options: ZipExportOptions = {}): Uint8Array {
  const exclude = options.exclude ?? [];
  const include = options.include;
  const excluded = (relative: string) => (include !== undefined && !under(relative, include)) || under(relative, exclude);
  const entries: Zippable = {};
  for (const dir of fs.explicitDirectories()) {
    const relative = dir.slice(1);
    if (!excluded(relative) && fs.readdir(dir).length === 0) entries[relative + '/'] = new Uint8Array(0);
  }
  for (const path of fs.list()) {
    const relative = path.slice(1);
    if (excluded(relative)) continue;
    const contents = fs.readFile(path)!;
    entries[relative] = typeof contents === 'string' ? encoder.encode(contents) : contents;
  }
  return zipSync(entries, { level: options.level ?? 6 });
}

/** What `importZip` accepts before refusing a zip (a zip bomb, or something that is not a project). */
export interface ZipImportLimits {
  /** Entries (files and directories). Default 250,000 — a large `node_modules`. */
  maxEntries?: number;
  /** One entry's unpacked size, in bytes. Default 256 MB. */
  maxEntryBytes?: number;
  /** All entries' unpacked size together, in bytes. Default 1 GB. */
  maxTotalBytes?: number;
}

export const DEFAULT_ZIP_IMPORT_LIMITS: Readonly<Required<ZipImportLimits>> = { maxEntries: 250_000, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 };

/** A zip `importZip` refused, before unpacking anything past the limit. */
export class ZipLimitError extends Error {
  readonly code = 'EZIPLIMIT';
  constructor(readonly limit: keyof ZipImportLimits, readonly value: number, readonly max: number, readonly entry?: string) {
    super(`The zip exceeds ${limit} (${value} > ${max})${entry ? ` at "${entry}"` : ''}.`);
    this.name = 'ZipLimitError';
  }
}

/**
 * Write a zip's contents into `fs` under `at` (default `/`), over whatever is
 * there. Entry names cannot climb out of `at` (`../x` lands at `<at>/x`). Throws
 * {@link ZipLimitError} — having written nothing — past `limits`.
 */
export function importZip(fs: VirtualFileSystem, zip: Uint8Array, at = '/', limits: ZipImportLimits = {}): void {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...DEFAULT_ZIP_IMPORT_LIMITS, ...limits };
  let entries = 0;
  let total = 0;
  const files = unzipSync(zip, {
    // Checked from the central directory before each entry is unpacked. A deflated
    // entry is inflated into a buffer of its declared size, so a lying size cannot overrun it.
    filter({ name, size, originalSize, compression }) {
      if (++entries > maxEntries) throw new ZipLimitError('maxEntries', entries, maxEntries);
      const unpacked = compression === 0 ? Math.max(size, originalSize) : originalSize;
      if (unpacked > maxEntryBytes) throw new ZipLimitError('maxEntryBytes', unpacked, maxEntryBytes, name);
      total += unpacked;
      if (total > maxTotalBytes) throw new ZipLimitError('maxTotalBytes', total, maxTotalBytes, name);
      return true;
    },
  });
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) {
      fs.mkdir(projectToBase(at, name.slice(0, -1)));
      continue;
    }
    let contents: string | Uint8Array = bytes;
    try {
      contents = strictUtf8.decode(bytes);
    } catch {
      // binary: keep the bytes
    }
    fs.writeFile(projectToBase(at, name), contents);
  }
}
