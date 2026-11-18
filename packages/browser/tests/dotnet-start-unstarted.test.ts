/**
 * A program that blocks on its own wait — not on a host it started — is not
 * "serving" (real bundle; one .NET process per file): it builds a host, never
 * runs it, then waits on a task. browser-wasm's one thread answers the wait
 * with PlatformNotSupportedException; with no host starting, that is an
 * unhandled exception: printed, exit 134, never treated as a running server.
 * Skipped until the bundle exists.
 */
import { describe, expect, it } from 'vitest';
import { DOTNET_BUNDLE_DIR, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { readAll } from './php-helpers.js';

const APP = String.raw`#:sdk Microsoft.NET.Sdk.Web
var app = WebApplication.CreateBuilder(args).Build();
Task.Delay(50).Wait();
Console.WriteLine("not reached");
`;

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET program blocking without a host (real bundle)', () => {
  it('exits 134 with the PlatformNotSupportedException printed', { timeout: 300_000 }, async () => {
    const { processes } = dotnetHost({ 'tool/app.cs': APP }, loadBundledDotnet);
    const proc = processes.run('dotnet', ['run', 'app.cs'], { cwd: '/tool' });
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(134);
    expect(output).toContain('Unhandled exception. System.PlatformNotSupportedException');
    expect(output).not.toContain('not reached');
    processes.dispose();
  });
});
