/**
 * A hosted service that throws while the host starts ends the program (real
 * bundle; one .NET process per file). The throw comes after an await, so
 * `app.Run()` has already given up blocking (PlatformNotSupportedException on
 * browser-wasm's one thread) and the failure is seen only in the host's own
 * log: the program exits as on an unhandled exception (134, the error
 * printed) instead of waiting forever. Skipped until the bundle exists.
 */
import { describe, expect, it } from 'vitest';
import { DOTNET_BUNDLE_DIR, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { readAll } from './php-helpers.js';

const APP = String.raw`#:sdk Microsoft.NET.Sdk.Web
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHostedService<Boom>();
var app = builder.Build();
app.MapGet("/", () => "hi");
app.Run();

class Boom : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await Task.Yield();
        throw new InvalidOperationException("boom while starting");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
`;

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET host start failure: a hosted service throws (real bundle)', () => {
  it('exits 134 with the error instead of hanging', { timeout: 300_000 }, async () => {
    const { processes } = dotnetHost({ 'web/app.cs': APP }, loadBundledDotnet);
    const proc = processes.run('dotnet', ['run', 'app.cs'], { cwd: '/web', env: { ASPNETCORE_URLS: 'http://localhost:5093' } });
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(134);
    expect(output).toContain('Unhandled exception.');
    expect(output).toContain('boom while starting');
    processes.dispose();
  });
});
