/**
 * A host whose server cannot start ends the program (real bundle; one .NET
 * process per file): ASPNETCORE_URLS naming a valid URL then one without a
 * scheme. The first port is claimed, the second URL throws in the in-memory
 * server's StartAsync — the program blocked in `app.Run()` exits as on an
 * unhandled exception (134, the error printed) instead of hanging, and the
 * port it had claimed is released. Skipped until the bundle exists.
 */
import { describe, expect, it } from 'vitest';
import { DOTNET_BUNDLE_DIR, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { readAll, until } from './php-helpers.js';

const APP = String.raw`#:sdk Microsoft.NET.Sdk.Web
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => "hi");
app.Run();
`;

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET host start failure: a URL without a scheme (real bundle)', () => {
  it('exits 134 with the error, releasing the port it had claimed', { timeout: 300_000 }, async () => {
    const { processes } = dotnetHost({ 'web/app.cs': APP }, loadBundledDotnet);
    const proc = processes.run('dotnet', ['run', 'app.cs'], { cwd: '/web', env: { ASPNETCORE_URLS: 'http://localhost:5091;localhost:5092' } });
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(134);
    expect(output).toContain('Unhandled exception.');
    expect(output).toContain("Invalid url: 'localhost:5092'");
    await until(() => !processes.ports.has(5091));
    processes.dispose();
  });
});
