// Running a compiled program inside this runtime: its assembly (and any beside it) loaded into the default
// context, its entry point invoked with the arguments, a Task-returning Main awaited, and its exit code
// returned as `dotnet app.dll` would (Main's int, else Environment.ExitCode; an unhandled exception prints
// "Unhandled exception." and exits 134, as on Linux).
//
// browser-wasm has one thread: a program that blocks waiting on its host — `app.Run()`, `host.Run()`,
// `WaitForShutdown()` — gets PlatformNotSupportedException ("Cannot wait on monitors") instead of
// blocking. The host it built is already starting (HostCapture saw it built), and keeps serving from the
// event loop, so the program is treated as running until that host stops — when the host has begun
// starting (HostCapture.Starting). If it then fails to start (its URLs refused, a hosted service throwing),
// the program ends as on an unhandled exception: printed, exit 134. A PlatformNotSupportedException with
// no host starting is the program's own blocking wait, and is unhandled the same way. `await
// app.RunAsync()` needs no such help.
using System.Reflection;
using System.Runtime.Loader;

namespace Bfwc.Host;

internal static class ProgramRunner
{
    static readonly HashSet<string> probed = new(StringComparer.Ordinal);

    internal static async Task<int> RunAsync(string assemblyPath, string[] args, string cwd)
    {
        if (!File.Exists(assemblyPath))
        {
            Console.Error.WriteLine($"The application to execute does not exist: '{assemblyPath}'.");
            return 1;
        }
        Directory.SetCurrentDirectory(cwd);
        var directory = Path.GetDirectoryName(Path.GetFullPath(assemblyPath))!;
        if (probed.Add(directory)) AssemblyLoadContext.Default.Resolving += (context, name) => ResolveBeside(directory, context, name);

        Assembly assembly;
        try
        {
            assembly = AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(File.ReadAllBytes(assemblyPath)));
        }
        catch (BadImageFormatException error)
        {
            Console.Error.WriteLine($"'{assemblyPath}' is not a .NET assembly: {error.Message}");
            return 1;
        }
        var entry = assembly.EntryPoint is { } declared ? AsyncEntryOf(declared) : null;
        if (entry is null)
        {
            Console.Error.WriteLine($"'{assemblyPath}' has no entry point: it is a class library.");
            return 1;
        }

        object? result;
        try
        {
            result = entry.Invoke(null, entry.GetParameters().Length == 0 ? [] : [args]);
            if (result is Task task)
            {
                await task;
                result = task.GetType().IsGenericType ? task.GetType().GetProperty("Result")!.GetValue(task) : null;
            }
        }
        catch (Exception error)
        {
            var thrown = error is TargetInvocationException { InnerException: { } inner } ? inner : error;
            // Blocked waiting on a host that is starting (`app.Run()`): it keeps serving from the event loop. A
            // PlatformNotSupportedException with no host starting is the program's own blocking wait: unhandled.
            if (thrown is PlatformNotSupportedException && HostCapture.Starting && HostCapture.Latest is { } host) return await HostCapture.WaitForShutdownAsync(host);
            Console.Error.WriteLine($"Unhandled exception. {thrown}");
            return HostCapture.UnhandledExceptionExitCode;
        }
        return result is int code ? code : Environment.ExitCode;
    }

    /// <summary>
    /// The method to run for an entry point. An async program (`async Task Main`, or top-level statements that
    /// await) has a compiler-made synchronous entry, <c>&lt;Main&gt;</c>, that blocks on the real method — which on
    /// browser-wasm's one thread throws instead of waiting. That real method (<c>Main</c> or <c>&lt;Main&gt;$</c>,
    /// returning a Task) is run instead, and awaited.
    /// </summary>
    static MethodInfo AsyncEntryOf(MethodInfo entry)
    {
        if (entry.Name != "<Main>" || entry.DeclaringType is not { } type) return entry;
        var parameters = entry.GetParameters().Length;
        return type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(method => method.Name is "Main" or "<Main>$" && typeof(Task).IsAssignableFrom(method.ReturnType) && method.GetParameters().Length == parameters) ?? entry;
    }

    static Assembly? ResolveBeside(string directory, AssemblyLoadContext context, AssemblyName name)
    {
        var path = Path.Combine(directory, $"{name.Name}.dll");
        return File.Exists(path) ? context.LoadFromStream(new MemoryStream(File.ReadAllBytes(path))) : null;
    }
}
