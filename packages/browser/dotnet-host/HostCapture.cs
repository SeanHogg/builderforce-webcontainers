// Every generic host a program builds gets the in-memory server instead of Kestrel, without the program
// changing: the "Microsoft.Extensions.Hosting" DiagnosticListener's HostBuilding event (the hook
// WebApplicationFactory uses) adds BrowserServer as the IServer after the program's own registrations,
// so it wins, and the console logger the host leaves out on browser (BrowserConsoleLogger). HostBuilt
// records the host, so a kill can stop it and a program blocked in `app.Run()` can be waited on
// (ProgramRunner).
//
// Whether a host is starting, started, or failed to start is read from the host itself: its own log
// (category Microsoft.Extensions.Hosting.Internal.Host, watched at every level by HostStartWatcher) says
// "Starting" when StartAsync begins, and an Error or worse before ApplicationStarted is a failed start —
// a hosted service throwing in StartAsync, the server refusing its URLs (BrowserServer reports those
// directly too). A program waiting on such a host ends as an unhandled exception would.
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Bfwc.Host;

internal sealed class HostCapture : IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>
{
    /// <summary>The generic host's own log category.</summary>
    internal const string HostCategory = "Microsoft.Extensions.Hosting.Internal.Host";

    /// <summary>The exit code of a program that ends on an unhandled exception (SIGABRT, as on Linux).</summary>
    internal const int UnhandledExceptionExitCode = 134;

    static readonly HostCapture Instance = new();
    static IDisposable? subscription;
    static readonly List<IHost> hosts = [];
    static readonly TaskCompletionSource<Exception> startFailure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    static bool starting;
    static bool started;

    internal static void Install() => subscription ??= DiagnosticListener.AllListeners.Subscribe(Instance);

    /// <summary>The last host the program built, if any.</summary>
    internal static IHost? Latest => hosts.Count > 0 ? hosts[^1] : null;

    /// <summary>A host began starting (its StartAsync ran): a program blocked in <c>app.Run()</c> is waiting on it.</summary>
    internal static bool Starting => starting;

    internal static void MarkStarting() => starting = true;

    /// <summary>A host failed to start (its server refused its URLs, a hosted service threw): a program waiting on it ends.</summary>
    internal static void StartFailed(Exception error)
    {
        if (!started) startFailure.TrySetResult(error);
    }

    /// <summary>Wait until the host stops (exit 0) or fails to start (an unhandled exception: printed, exit 134).</summary>
    internal static async Task<int> WaitForShutdownAsync(IHost host)
    {
        var lifetime = host.Services.GetService<IHostApplicationLifetime>();
        if (lifetime is null) return 0;
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = lifetime.ApplicationStopped.Register(() => stopped.TrySetResult());
        var first = await Task.WhenAny(stopped.Task, startFailure.Task);
        if (first == stopped.Task && !startFailure.Task.IsCompleted) return 0;
        Console.Error.WriteLine($"Unhandled exception. {startFailure.Task.Result}");
        return UnhandledExceptionExitCode;
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
                builder.ConfigureServices(services =>
                {
                    services.AddSingleton<IServer, BrowserServer>();
                    services.AddSingleton<ILoggerProvider, BrowserConsoleLoggerProvider>();
                    services.AddSingleton<ILoggerProvider, HostStartWatcherProvider>();
                    // The watcher hears the host's own category at every level (its "Starting" is Debug), whatever the app's filters say.
                    services.Configure<LoggerFilterOptions>(options => options.AddFilter<HostStartWatcherProvider>(HostCategory, LogLevel.Trace));
                });
                break;
            case "HostBuilt" when entry.Value is IHost host:
                hosts.Add(host);
                host.Services.GetService<IHostApplicationLifetime>()?.ApplicationStarted.Register(() => started = true);
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

/// <summary>Reads the generic host's own log: "Starting" (event 1) marks a start begun; an Error before ApplicationStarted is a failed start.</summary>
internal sealed class HostStartWatcherProvider : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => categoryName == HostCapture.HostCategory ? new Watcher() : NullLogger.Instance;

    public void Dispose()
    {
    }

    sealed class Watcher : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Id == 1 || eventId.Name == "Starting") HostCapture.MarkStarting();
            if (logLevel >= LogLevel.Error) HostCapture.StartFailed(exception ?? new InvalidOperationException(formatter(state, exception)));
        }
    }

    sealed class NullLogger : ILogger
    {
        internal static readonly NullLogger Instance = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => false;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
        }
    }
}
