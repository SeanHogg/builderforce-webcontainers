/**
 * A server that speaks first loses nothing (real bundle; one .NET process per
 * file). The dialled connection here delivers its greeting the moment the
 * Worker subscribes — before the connection id has reached .NET — as a server
 * writing on accept can. The greeting is a Postgres ErrorResponse (what a
 * server out of connection slots sends at once), so Npgsql's OpenAsync must
 * read it from the bytes .NET held for the not-yet-registered id; were they
 * dropped, it would wait until its timeout instead. Skipped until the bundle
 * exists.
 */
import { describe, expect, it } from 'vitest';
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import { DOTNET_BUNDLE_DIR, DOTNET_BUNDLE_URL, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { readAll } from './php-helpers.js';

const APP = String.raw`#:package Npgsql@9.0.3
using Npgsql;
try
{
    await using var connection = new NpgsqlConnection("Host=localhost;Port=5999;Username=u;SSL Mode=Disable;Timeout=5");
    await connection.OpenAsync();
    Console.WriteLine("opened");
    return 0;
}
catch (PostgresException e)
{
    Console.WriteLine($"server said: {e.SqlState} {e.MessageText}");
    return 2;
}
`;

/** A Postgres ErrorResponse: FATAL 53300. */
function errorResponse(): Uint8Array {
  const fields = 'SFATAL\0VFATAL\0C53300\0Msorry, too many clients already\0\0';
  const body = new TextEncoder().encode(fields);
  const message = new Uint8Array(1 + 4 + body.length);
  message[0] = 0x45; // 'E'
  new DataView(message.buffer).setInt32(1, 4 + body.length);
  message.set(body, 5);
  return message;
}

/** A connection whose greeting arrives the instant a reader subscribes. */
function speaksFirst(): ByteChannel {
  const closers: Array<() => void> = [];
  let closed = false;
  return {
    send() {},
    close() {
      if (closed) return;
      closed = true;
      for (const closer of closers) closer();
    },
    onData(listener: (data: Uint8Array) => void) {
      listener(errorResponse());
      return () => undefined;
    },
    onClose(listener: () => void) {
      closers.push(listener);
      return () => undefined;
    },
    manualFlowControl() {},
    consumed() {},
  } as unknown as ByteChannel;
}

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET virtual TCP: a server that speaks first (real bundle)', () => {
  it('delivers the greeting sent before the connection id reached .NET', { timeout: 300_000 }, async () => {
    const { processes } = dotnetHost({ 'tool/app.cs': APP }, loadBundledDotnet, { bundleUrl: DOTNET_BUNDLE_URL }, async (port) => (port === 5999 ? speaksFirst() : undefined));
    const proc = processes.run('dotnet', ['run', 'app.cs'], { cwd: '/tool' });
    const output = await readAll(proc.combinedOutput);
    expect(output).toContain('server said: 53300 sorry, too many clients already');
    expect(await proc.wait()).toBe(2);
    processes.dispose();
  });
});
