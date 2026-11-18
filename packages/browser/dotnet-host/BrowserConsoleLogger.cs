// The console logger for hosts in this runtime. The generic host leaves Microsoft.Extensions.Logging.Console
// out on browser (its processor needs a thread), so programs would log nothing; HostCapture adds this provider
// instead. It writes the simple console format synchronously ("info: Category[0]" then the message indented),
// so "Now listening on: …" and the program's own logs reach stdout. Aliased "Console", so `Logging:Console`
// configuration applies to it; the usual `Logging:LogLevel` filters apply as to any provider.
using Microsoft.Extensions.Logging;

namespace Bfwc.Host;

[ProviderAlias("Console")]
internal sealed class BrowserConsoleLoggerProvider : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new BrowserConsoleLogger(categoryName);

    public void Dispose()
    {
    }

    sealed class BrowserConsoleLogger(string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            var message = formatter(state, exception);
            if (string.IsNullOrEmpty(message) && exception is null) return;
            var label = logLevel switch
            {
                LogLevel.Trace => "trce",
                LogLevel.Debug => "dbug",
                LogLevel.Information => "info",
                LogLevel.Warning => "warn",
                LogLevel.Error => "fail",
                _ => "crit",
            };
            var text = $"{label}: {category}[{eventId.Id}]\n      {message.Replace("\n", "\n      ")}\n";
            if (exception is not null) text += $"      {exception.ToString().Replace("\n", "\n      ")}\n";
            if (logLevel >= LogLevel.Error) Console.Error.Write(text);
            else Console.Out.Write(text);
        }
    }
}
