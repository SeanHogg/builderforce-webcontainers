// The boundary between the .NET process Worker (runtimes/dotnet/dotnetInterop.ts) and this host.
// `Js` is what the Worker provides (module "bfwc", given to setModuleImports before any export runs);
// `Exports` is what the Worker calls. Bytes cross as copies (byte[] <-> Uint8Array): never shared memory.
using System.Runtime.InteropServices.JavaScript;

namespace Bfwc.Host;

internal static partial class Js
{
    [JSImport("stdout", "bfwc")]
    internal static partial void Stdout(string text);

    [JSImport("stderr", "bfwc")]
    internal static partial void Stderr(string text);

    /// <summary>Claim a virtual port for this process's server: false when another process holds it.</summary>
    [JSImport("listen", "bfwc")]
    internal static partial bool Listen(int port);

    [JSImport("unlisten", "bfwc")]
    internal static partial void Unlisten(int port);

    /// <summary>The response head for request <paramref name="reqId"/>; headers as JSON <c>{ name: [values] }</c>.</summary>
    [JSImport("respondHead", "bfwc")]
    internal static partial void RespondHead(int reqId, int status, string headersJson);

    [JSImport("respondChunk", "bfwc")]
    internal static partial void RespondChunk(int reqId, byte[] data);

    /// <summary>The response is complete; <paramref name="error"/> set when it failed after its head went out.</summary>
    [JSImport("respondEnd", "bfwc")]
    internal static partial void RespondEnd(int reqId, string? error);

    /// <summary>Dial a virtual port anywhere in the runtime: the connection id, or -1 when nothing listens.</summary>
    [JSImport("dial", "bfwc")]
    internal static partial Task<int> Dial(int port);

    [JSImport("send", "bfwc")]
    internal static partial void Send(int connId, byte[] data);

    [JSImport("hangUp", "bfwc")]
    internal static partial void HangUp(int connId);
}

public static partial class Exports
{
    /// <summary>Console to the Worker's stdio, Npgsql onto virtual TCP, ASP.NET Core hosts onto the in-memory server.</summary>
    [JSExport]
    public static void Init()
    {
        JsConsole.Install();
        Npgsql.NpgsqlStreamTransport.Connect = VirtualTcp.ConnectAsync;
        HostCapture.Install();
    }

    /// <summary>Compile a project as planned by runtimes/dotnet/dotnetProject.ts: the exit code (0 built, 1 failed).</summary>
    [JSExport]
    public static Task<int> Build(string planJson) => CompileService.BuildAsync(planJson);

    /// <summary>Run a program's entry point: its exit code, once it returns (a served app returns when it stops).</summary>
    [JSExport]
    public static Task<int> Run(string assemblyPath, string[] args, string cwd) => ProgramRunner.RunAsync(assemblyPath, args, cwd);

    [JSExport]
    public static void Request(int reqId, int port, string method, string url, string headersJson, byte[] body) =>
        BrowserServer.Dispatch(reqId, port, method, url, headersJson, body);

    [JSExport]
    public static void CancelRequest(int reqId) => BrowserServer.Cancel(reqId);

    /// <summary>Ask a running host to stop (a kill): its lifetime's StopApplication.</summary>
    [JSExport]
    public static void Stop() => HostCapture.StopAll();

    [JSExport]
    public static void TcpData(int connId, byte[] data) => VirtualTcp.Received(connId, data);

    [JSExport]
    public static void TcpClosed(int connId) => VirtualTcp.Closed(connId);

    /// <summary>Flush the console writers (before the Worker reports an exit).</summary>
    [JSExport]
    public static void Flush() => JsConsole.Flush();
}
