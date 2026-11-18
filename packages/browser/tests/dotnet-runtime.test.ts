/**
 * A console program on the real .NET bundle (one process: Mono's runtime is a
 * singleton of the test file's realm): a file-based program (`dotnet run
 * app.cs`) is compiled by Roslyn with its `#:` directives, gets its arguments
 * and environment, reads the project's files, writes files that reach the
 * page, and exits with Main's code. Skipped until the bundle exists.
 */
import { describe, expect, it } from 'vitest';
import { DOTNET_BUNDLE_DIR, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { readAll, until } from './php-helpers.js';

const APP = String.raw`#!/usr/bin/env dotnet
#:property Nullable=enable
var input = File.ReadAllText("data/in.txt");
Directory.CreateDirectory("out");
File.WriteAllText("out/result.txt", $"{input.Trim()} -> {string.Join(",", args)}");
Console.WriteLine($"args={string.Join(" ", args)} env={Environment.GetEnvironmentVariable("GREETING")} cwd={Environment.CurrentDirectory}");
Console.Error.WriteLine("to stderr");
return args.Length;
`;

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET console program (real bundle)', () => {
  it('builds and runs a file-based program with arguments, environment, files and exit code', { timeout: 300_000 }, async () => {
    const { fs, processes } = dotnetHost({ 'tools/app.cs': APP, 'tools/data/in.txt': 'from the page\n' }, loadBundledDotnet);
    const proc = processes.run('dotnet', ['run', 'app.cs', 'a', 'b', 'c'], { cwd: '/tools', env: { GREETING: 'hi' } });
    const output = await readAll(proc.combinedOutput);
    expect(output).toContain('args=a b c env=hi cwd=/project/tools\n');
    expect(output).toContain('to stderr\n');
    expect(await proc.wait()).toBe(3);
    await until(() => fs.readText('/tools/out/result.txt') !== undefined);
    expect(fs.readText('/tools/out/result.txt')).toBe('from the page -> a,b,c');
    processes.dispose();
  });
});
