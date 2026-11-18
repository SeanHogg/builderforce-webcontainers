/**
 * A file-system snapshot as ONE ArrayBuffer: handing it to a process Worker is
 * a single memcpy, not a structured clone of thousands of strings, and the
 * Worker reads a file's contents out of it only when the file is first opened.
 *
 * Layout (native byte order: a pack never leaves the machine that built it):
 *
 *   header      u32 × 8   magic, format, seq low, seq high, files, dirs, path chars, contents offset
 *   pathLengths u32 × (files + dirs)   UTF-16 length of each path, files first
 *   fileTable   u32 × files × 3        kind, offset (from contents), byte length
 *   paths       u16 × path chars       every path's UTF-16 code units, back to back
 *   contents    bytes                   each file, in table order
 *
 * Kinds: 0 UTF-8 text, 1 bytes, 2 UTF-16 text (a string that is not well-formed
 * Unicode — lone surrogates do not survive UTF-8, so those keep their code units).
 * Paths are stored as code units for the same reason. Every value round-trips
 * exactly, a leading BOM included.
 */
import type { FileContent, VirtualFileSystem } from '../vfs.js';

const MAGIC = 0x4b504642; // 'BFPK'
const FORMAT = 1;
const HEADER_WORDS = 8;
const TEXT = 0;
const BYTES = 1;
const UTF16 = 2;

const encoder = new TextEncoder();
/** `ignoreBOM`: a file that starts with U+FEFF keeps it. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** What a pack holds, contents not yet read: each file's is a function that copies it out. */
export interface UnpackedSnapshot {
  /** The journal sequence the snapshot was taken at. */
  seq: number;
  files: Array<[string, () => FileContent]>;
  /** Explicit directories (`explicitDirectories()`). */
  dirs: string[];
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormed(text: string): boolean {
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  return native ? native.call(text) : !LONE_SURROGATE.test(text);
}

const align = (n: number, to: number) => Math.ceil(n / to) * to;

/** A byte buffer that grows by doubling. */
class Writer {
  bytes: Uint8Array;
  end: number;

  constructor(start: number, capacity: number) {
    this.end = start;
    this.bytes = new Uint8Array(Math.max(capacity, start));
  }

  ensure(extra: number): void {
    if (this.end + extra <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.end + extra));
    grown.set(this.bytes.subarray(0, this.end));
    this.bytes = grown;
  }
}

/** Pack `fs` (every file and explicit directory) as it is now, labelled with journal sequence `seq`. */
export function packFileSystem(fs: VirtualFileSystem, seq: number): ArrayBuffer {
  const paths = fs.list();
  const dirs = fs.explicitDirectories();
  const contents = paths.map((path) => fs.readFile(path)!);
  const fileCount = paths.length;
  const all = [...paths, ...dirs];
  let pathChars = 0;
  for (const path of all) pathChars += path.length;

  const tableOffset = (HEADER_WORDS + all.length) * 4;
  const pathsOffset = tableOffset + fileCount * 12;
  const contentsOffset = align(pathsOffset + pathChars * 2, 8);
  let estimate = 0;
  for (const content of contents) estimate += typeof content === 'string' ? content.length : content.byteLength;
  // Exact for ASCII text and bytes, so the common pack needs no growth and no final copy.
  const writer = new Writer(contentsOffset, contentsOffset + estimate);

  const kinds = new Uint32Array(fileCount * 3);
  contents.forEach((content, i) => {
    const start = writer.end;
    if (typeof content !== 'string') {
      kinds[i * 3] = BYTES;
      writer.ensure(content.byteLength);
      writer.bytes.set(content, writer.end);
      writer.end += content.byteLength;
    } else if (isWellFormed(content)) {
      kinds[i * 3] = TEXT;
      // Sized for ASCII; grow only when a string's UTF-8 turns out longer than the room left.
      for (let rest = content; ; ) {
        const { read, written } = encoder.encodeInto(rest, writer.bytes.subarray(writer.end));
        writer.end += written;
        if (read === rest.length) break;
        rest = rest.slice(read);
        writer.ensure(rest.length * 3);
      }
    } else {
      kinds[i * 3] = UTF16;
      writer.ensure(content.length * 2 + 1);
      if (writer.end % 2) writer.end++;
      const units = new Uint16Array(writer.bytes.buffer, writer.end, content.length);
      for (let c = 0; c < content.length; c++) units[c] = content.charCodeAt(c);
      writer.end += content.length * 2;
    }
    const offset = kinds[i * 3] === UTF16 ? align(start, 2) : start;
    kinds[i * 3 + 1] = offset - contentsOffset;
    kinds[i * 3 + 2] = writer.end - offset;
  });

  // Offsets and lengths are u32: past 4 GiB of contents they would wrap silently.
  if (writer.end - contentsOffset > 0xffffffff) throw new RangeError('The file system is too large to pack (over 4 GiB of contents).');
  const out = writer.end === writer.bytes.length ? writer.bytes : writer.bytes.slice(0, writer.end);
  const buffer = out.buffer as ArrayBuffer;
  const header = new Uint32Array(buffer, 0, HEADER_WORDS + all.length);
  header.set([MAGIC, FORMAT, seq % 2 ** 32, Math.floor(seq / 2 ** 32), fileCount, dirs.length, pathChars, contentsOffset]);
  all.forEach((path, i) => (header[HEADER_WORDS + i] = path.length));
  new Uint32Array(buffer, tableOffset, fileCount * 3).set(kinds);
  const units = new Uint16Array(buffer, pathsOffset, pathChars);
  let at = 0;
  for (const path of all) for (let c = 0; c < path.length; c++) units[at++] = path.charCodeAt(c);
  return buffer;
}

/** Code units → a string, in chunks small enough for `fromCharCode`'s argument limit. */
function fromUnits(units: Uint16Array): string {
  let text = '';
  for (let i = 0; i < units.length; i += 8192) text += String.fromCharCode.apply(null, units.subarray(i, i + 8192) as unknown as number[]);
  return text;
}

/** Read a pack's index. Contents stay in `buffer` until each file's function is called. */
export function readPack(buffer: ArrayBuffer): UnpackedSnapshot {
  const head = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (head[0] !== MAGIC || head[1] !== FORMAT) throw new Error('Not a file-system pack (or a pack from another runtime version).');
  const seq = head[2]! + head[3]! * 2 ** 32;
  const fileCount = head[4]!;
  const dirCount = head[5]!;
  const pathChars = head[6]!;
  const contentsOffset = head[7]!;
  const total = fileCount + dirCount;
  const lengths = new Uint32Array(buffer, HEADER_WORDS * 4, total);
  const tableOffset = (HEADER_WORDS + total) * 4;
  const table = new Uint32Array(buffer, tableOffset, fileCount * 3);
  const joined = fromUnits(new Uint16Array(buffer, tableOffset + fileCount * 12, pathChars));

  const names: string[] = new Array(total);
  let at = 0;
  for (let i = 0; i < total; i++) {
    const end = at + lengths[i]!;
    names[i] = joined.slice(at, end);
    at = end;
  }

  const files: Array<[string, () => FileContent]> = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const kind = table[i * 3]!;
    const start = contentsOffset + table[i * 3 + 1]!;
    const length = table[i * 3 + 2]!;
    files[i] = [names[i]!, () => readContent(buffer, kind, start, length)];
  }
  return { seq, files, dirs: names.slice(fileCount) };
}

function readContent(buffer: ArrayBuffer, kind: number, start: number, length: number): FileContent {
  if (kind === BYTES) return new Uint8Array(buffer.slice(start, start + length));
  if (kind === UTF16) return fromUnits(new Uint16Array(buffer.slice(start, start + length)));
  return decoder.decode(new Uint8Array(buffer, start, length));
}
