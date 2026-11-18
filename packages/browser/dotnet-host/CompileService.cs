// In-browser builds: Roslyn, running in this runtime, compiles a project as planned by the Worker
// (runtimes/dotnet/dotnetProject.ts — sources, global usings, reference assemblies already mounted,
// options) and writes the assembly where `dotnet build` would. Diagnostics print as MSBuild does
// ("Program.cs(3,5): error CS0103: … [api.csproj]"), then "Build succeeded." or "Build FAILED.".
//
// browser-wasm has one thread: the compilation is never concurrent (concurrentBuild: false), or Roslyn
// would wait on monitors. Source generators and analyzers are not run.
using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Bfwc.Host;

internal sealed record BuildPlan(
    string ProjectFile,
    string ProjectDir,
    string AssemblyName,
    string OutputKind,
    string OutputPath,
    string[] Sources,
    string GlobalUsings,
    string[] References,
    string Nullable,
    bool AllowUnsafe,
    string? LangVersion,
    string[] Defines,
    bool Optimize,
    bool WarningsAsErrors,
    string[] NoWarn,
    bool Quiet,
    bool FileBased);

internal static class CompileService
{
    static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    static readonly Dictionary<string, MetadataReference> references = new(StringComparer.Ordinal);

    internal static Task<int> BuildAsync(string planJson)
    {
        var plan = JsonSerializer.Deserialize<BuildPlan>(planJson, Json) ?? throw new ArgumentException("No build plan.");
        var clock = Stopwatch.StartNew();
        var project = Path.GetFileName(plan.ProjectFile);
        var compilation = Create(plan);
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        var shown = result.Diagnostics.Where(d => d.Severity >= DiagnosticSeverity.Warning && !d.IsSuppressed).ToList();
        foreach (var diagnostic in shown) Console.WriteLine($"{Describe(diagnostic, plan.ProjectDir)} [{project}]");
        var errors = shown.Count(d => d.Severity == DiagnosticSeverity.Error);
        var warnings = shown.Count - errors;
        if (result.Success)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(plan.OutputPath)!);
            File.WriteAllBytes(plan.OutputPath, image.ToArray());
            // `dotnet run` shows only the diagnostics of the build it does.
            if (plan.Quiet) return Task.FromResult(0);
            Console.WriteLine($"  {plan.AssemblyName} -> {plan.OutputPath}");
            Console.WriteLine();
            Console.WriteLine("Build succeeded.");
        }
        else
        {
            Console.WriteLine();
            Console.WriteLine("Build FAILED.");
        }
        Console.WriteLine($"    {warnings} Warning(s)");
        Console.WriteLine($"    {errors} Error(s)");
        Console.WriteLine();
        Console.WriteLine($"Time Elapsed {clock.Elapsed:hh\\:mm\\:ss\\.ff}");
        return Task.FromResult(result.Success ? 0 : 1);
    }

    static CSharpCompilation Create(BuildPlan plan)
    {
        // The Worker always sends one: the project's LangVersion, else the SDK's default for its target framework.
        var language = LanguageVersion.Latest;
        if (plan.LangVersion is { Length: > 0 } requested && !LanguageVersionFacts.TryParse(requested, out language))
            throw new ArgumentException($"Invalid LangVersion '{requested}'.");
        var parse = new CSharpParseOptions(language, preprocessorSymbols: plan.Defines);
        var trees = plan.Sources.Select(path =>
        {
            var text = File.ReadAllText(path);
            return CSharpSyntaxTree.ParseText(SourceText.From(plan.FileBased ? WithoutRunDirectives(text) : text, Encoding.UTF8), parse, path);
        }).ToList();
        if (plan.GlobalUsings.Length > 0) trees.Add(CSharpSyntaxTree.ParseText(plan.GlobalUsings, parse, Path.Combine(plan.ProjectDir, "obj", $"{plan.AssemblyName}.GlobalUsings.g.cs")));

        var kind = plan.OutputKind == "library" ? OutputKind.DynamicallyLinkedLibrary : OutputKind.ConsoleApplication;
        var suppressed = plan.NoWarn.Select(code => code.Trim()).Where(code => code.Length > 0).Select(code => char.IsDigit(code[0]) ? $"CS{code.PadLeft(4, '0')}" : code)
            .ToImmutableDictionary(code => code, _ => ReportDiagnostic.Suppress);
        var options = new CSharpCompilationOptions(
            kind,
            optimizationLevel: plan.Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug,
            allowUnsafe: plan.AllowUnsafe,
            nullableContextOptions: NullableOf(plan.Nullable),
            generalDiagnosticOption: plan.WarningsAsErrors ? ReportDiagnostic.Error : ReportDiagnostic.Default,
            specificDiagnosticOptions: suppressed,
            concurrentBuild: false,
            deterministic: true);
        return CSharpCompilation.Create(plan.AssemblyName, trees, plan.References.Select(ReferenceOf), options);
    }

    /// <summary>
    /// A file-based program's leading `#!` line and `#:` directives, blanked so line numbers hold (the Worker
    /// reads them: runtimes/dotnet/dotnetProjectFile.ts `runDirectives`, the same rule). Directives count only at
    /// the top — among blank and `//` comment lines — and the scan stops at the first other line, so a `#:` further
    /// down is left for the compiler to report.
    /// </summary>
    static string WithoutRunDirectives(string text)
    {
        if (!text.Contains("#:") && !text.StartsWith("#!", StringComparison.Ordinal)) return text;
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var trimmed = lines[i].TrimEnd('\r').Trim();
            var blank = lines[i].EndsWith('\r') ? "\r" : "";
            if (i == 0 && trimmed.StartsWith("#!", StringComparison.Ordinal)) lines[i] = blank;
            else if (trimmed.Length == 0 || trimmed.StartsWith("//", StringComparison.Ordinal)) continue;
            else if (trimmed.StartsWith("#:", StringComparison.Ordinal)) lines[i] = blank;
            else break;
        }
        return string.Join('\n', lines);
    }

    static NullableContextOptions NullableOf(string value) => value.ToLowerInvariant() switch
    {
        "enable" => NullableContextOptions.Enable,
        "warnings" => NullableContextOptions.Warnings,
        "annotations" => NullableContextOptions.Annotations,
        _ => NullableContextOptions.Disable,
    };

    /// <summary>Reference assemblies are read once per runtime: a later build reuses them.</summary>
    static MetadataReference ReferenceOf(string path)
    {
        if (!references.TryGetValue(path, out var reference)) references[path] = reference = MetadataReference.CreateFromFile(path);
        return reference;
    }

    static string Describe(Diagnostic diagnostic, string projectDir)
    {
        var severity = diagnostic.Severity == DiagnosticSeverity.Error ? "error" : "warning";
        var span = diagnostic.Location.GetMappedLineSpan();
        if (!span.IsValid || string.IsNullOrEmpty(span.Path)) return $"CSC : {severity} {diagnostic.Id}: {diagnostic.GetMessage()}";
        var path = span.Path.StartsWith(projectDir + "/", StringComparison.Ordinal) ? span.Path[(projectDir.Length + 1)..] : span.Path;
        var start = span.StartLinePosition;
        return $"{path}({start.Line + 1},{start.Character + 1}): {severity} {diagnostic.Id}: {diagnostic.GetMessage()}";
    }
}
