// Every generic host a program builds gets the in-memory server instead of Kestrel, without the program
// changing: the "Microsoft.Extensions.Hosting" DiagnosticListener's HostBuilding event (the hook
// WebApplicationFactory uses) adds BrowserServer as the IServer after the program's own registrations,
// so it wins. HostBuilt records the host, so a kill can stop it and a program blocked in `app.Run()`
// can be waited on (ProgramRunner).
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Bfwc.Host;

internal sealed class HostCapture : IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>
{
    static readonly HostCapture Instance = new();
    static IDisposable? subscription;
    static readonly List<IHost> hosts = [];
    static readonly TaskCompletionSource<Exception> startFailure = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal static void Install() => subscription ??= DiagnosticListener.AllListeners.Subscribe(Instance);

    /// <summary>The last host the program built, if any.</summary>
    internal static IHost? Latest => hosts.Count > 0 ? hosts[^1] : null;

    /// <summary>A server failed to start (its port taken): a program waiting on its host ends.</summary>
    internal static void StartFailed(Exception error) => startFailure.TrySetResult(error);

    /// <summary>Wait until the host stops (exit 0) or its server fails to start (exit 1).</summary>
    internal static async Task<int> WaitForShutdownAsync(IHost host)
    {
        var lifetime = host.Services.GetService<IHostApplicationLifetime>();
        if (lifetime is null) return 0;
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = lifetime.ApplicationStopped.Register(() => stopped.TrySetResult());
        var first = await Task.WhenAny(stopped.Task, startFailure.Task);
        if (first == stopped.Task) return 0;
        Console.Error.WriteLine($"Unhandled exception. {startFailure.Task.Result}");
        return 1;
    }

    internal static void StopAll()
    {
        foreach (var host in hosts) host.Services.GetService<IHostApplicationLifetime>()?.StopApplication();
    }

    public void OnNext(DiagnosticListener listener)
    {
        if (listener.Name == "Microsoft.Extensions.Hosting") listener.Subscribe(this);
    }

    public void OnNext(KeyValuePair<string, object?> entry)
    {
        switch (entry.Key)
        {
            case "HostBuilding" when entry.Value is IHostBuilder builder:
                builder.ConfigureServices(services => services.AddSingleton<IServer, BrowserServer>());
                break;
            case "HostBuilt" when entry.Value is IHost host:
                hosts.Add(host);
                break;
        }
    }

    public void OnCompleted()
    {
    }

    public void OnError(Exception error)
    {
    }
}
