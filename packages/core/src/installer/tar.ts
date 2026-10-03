/**
 * A minimal tar reader: enough for npm tarballs. ustar headers with the `prefix`
 * field, pax extended headers (`path`, `linkpath`, `size`) and GNU long names.
 * Everything else (devices, fifos) is skipped. Symlinks are surfaced as entries
 * so the caller can decide; npm tarballs essentially never contain them.
 */

export interface TarEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  data: Uint8Array;
  mode: number;
  linkpath?: string;
}

const BLOCK = 512;
const decoder = new TextDecoder();

function str(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return decoder.decode(nul < 0 ? slice : slice.subarray(0, nul));
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  // GNU base-256 encoding for sizes over 8 GiB: top bit of the first byte set.
  if (bytes[start]! & 0x80) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + bytes[i]!;
    return value;
  }
  const text = str(bytes, start, length).trim();
  return text ? parseInt(text, 8) : 0;
}

/** Parse pax `"<len> key=value\n"` records. */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = decoder.decode(data);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const length = parseInt(text.slice(i, space), 10);
    if (!length) break;
    // The length counts bytes, but these records are ASCII in practice; fall back
    // to the newline when a multi-byte path makes the count disagree.
    let record = text.slice(space + 1, i + length);
    if (!record.endsWith('\n')) record = text.slice(space + 1, text.indexOf('\n', space) + 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, '');
    i = space + 1 + record.length;
  }
  return out;
}

function isZeroBlock(bytes: Uint8Array, at: number): boolean {
  for (let i = at; i < at + BLOCK; i++) if (bytes[i] !== 0) return false;
  return true;
}

export function untar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;

  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break;
    const name = str(bytes, offset, 100);
    const mode = octal(bytes, offset + 100, 8);
    const headerSize = octal(bytes, offset + 124, 12);
    const typeflag = String.fromCharCode(bytes[offset + 156] || 48);
    const linkname = str(bytes, offset + 157, 100);
    const magic = str(bytes, offset + 257, 6);
    const prefix = magic.startsWith('ustar') ? str(bytes, offset + 345, 155) : '';
    const merged = { ...globalPax, ...pax };
    const size = merged.size ? Number(merged.size) : headerSize;
    const dataStart = offset + BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === 'g') {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (typeflag === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (typeflag === 'K') {
      longLink = str(data, 0, data.length);
      continue;
    }

    const path = merged.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkpath = merged.linkpath ?? longLink ?? linkname;
    pax = {};
    longName = undefined;
    longLink = undefined;

    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') entries.push({ path, type: 'file', data, mode });
    else if (typeflag === '5') entries.push({ path, type: 'directory', data: new Uint8Array(0), mode });
    else if (typeflag === '2') entries.push({ path, type: 'symlink', data: new Uint8Array(0), mode, linkpath });
    else if (typeflag === '1') entries.push({ path, type: 'symlink', data: new Uint8Array(0), mode, linkpath }); // hard link: same treatment
  }
  return entries;
}

/** Write a tar archive (ustar). Used by tests to build fixture tarballs. */
export function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const data = typeof contents === 'string' ? encoder.encode(contents) : contents;
    const header = new Uint8Array(BLOCK);
    const put = (text: string, at: number, length: number) => header.set(encoder.encode(text).subarray(0, length), at);
    let name = path;
    let prefix = '';
    if (encoder.encode(path).length > 100) {
      const cut = path.lastIndexOf('/', 155);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
    put(name, 0, 100);
    put('0000644\0', 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    put('00000000000\0', 136, 12);
    put('        ', 148, 8);
    header[156] = 48; // '0'
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put(prefix, 345, 155);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
