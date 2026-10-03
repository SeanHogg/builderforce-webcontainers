import { describe, expect, it } from 'vitest';
import { tar, untar } from '../../src/installer/tar.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function header(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(512);
  h.set(encoder.encode(name), 0);
  h.set(encoder.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
  h[156] = type.charCodeAt(0);
  h.set(encoder.encode('ustar\0'), 257);
  return h;
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('untar', () => {
  it('round-trips files, including a long path split into the ustar prefix', () => {
    const long = `package/${'deep/'.repeat(30)}file.js`;
    const entries = untar(tar({ 'package/package.json': '{"name":"x"}', [long]: 'ok', 'package/bin.dat': new Uint8Array([0, 1, 2]) }));
    expect(entries.map((e) => e.path)).toEqual(['package/package.json', long, 'package/bin.dat']);
    expect(decoder.decode(entries[1]!.data)).toBe('ok');
    expect([...entries[2]!.data]).toEqual([0, 1, 2]);
  });

  it('applies pax path headers and GNU long names', () => {
    const paxBody = encoder.encode('29 path=package/from-pax.txt\n');
    const longName = encoder.encode('package/gnu-long-name.txt\0');
    const data = encoder.encode('hi');
    const archive = concat(
      header('PaxHeader', paxBody.length, 'x'), padded(paxBody),
      header('short', data.length, '0'), padded(data),
      header('././@LongLink', longName.length, 'L'), padded(longName),
      header('trunc', data.length, '0'), padded(data),
      header('package/dir/', 0, '5'),
      new Uint8Array(1024),
    );
    const entries = untar(archive);
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['package/from-pax.txt', 'file'],
      ['package/gnu-long-name.txt', 'file'],
      ['package/dir/', 'directory'],
    ]);
  });
});
