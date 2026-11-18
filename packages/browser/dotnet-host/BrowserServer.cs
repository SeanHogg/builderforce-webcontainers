// The in-memory IServer: Kestrel cannot bind sockets in browser-wasm, so ASP.NET Core's request pipeline
// is fed from the Worker's `http-request` messages instead. Starting claims each configured URL's port on
// the runtime's virtual network (Js.Listen; the default is Kestrel's http://localhost:5000) and fills
// IServerAddressesFeature, so the host logs "Now listening on: …" as usual. Each request becomes an
// HttpContext built from features (as TestServer does); the response streams back (BrowserResponse).
// There is no TLS: an https:// URL is served as plain HTTP on its port.
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Bfwc.Host;

public sealed partial class BrowserServer : IServer
{
    public const string DefaultUrl = "http://localhost:5000";

    static readonly Dictionary<int, BrowserServer> servers = [];
    static readonly Dictionary<int, CancellationTokenSource> requests = [];
    static int nextConnection = 1;

    readonly AddressesFeature addresses = new();
    readonly List<int> ports = [];
    Func<int, IFeatureCollection, BrowserResponse, Task>? process;

    public BrowserServer() => Features.Set<IServerAddressesFeature>(addresses);

    public IFeatureCollection Features { get; } = new FeatureCollection();

    [GeneratedRegex(@"^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*)://(?<host>\[[^\]]*\]|[^:/]*)(?::(?<port>\d+))?(?<path>/.*)?$")]
    private static partial Regex UrlPattern();

    /// <summary>The port a server URL binds (Kestrel's forms: <c>http://*:5000</c>, <c>http://+:80</c>, <c>https://localhost</c>).</summary>
    public static int PortOf(string url)
    {
        var match = UrlPattern().Match(url.Trim());
        if (!match.Success) throw new InvalidOperationException($"Invalid url: '{url}'");
        if (match.Groups["port"].Success) return int.Parse(match.Groups["port"].Value);
        return match.Groups["scheme"].Value.Equals("https", StringComparison.OrdinalIgnoreCase) ? 443 : 80;
    }

    public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull
    {
        var urls = addresses.Addresses.Count > 0 ? addresses.Addresses.ToList() : [DefaultUrl];
        addresses.Addresses.Clear();
        foreach (var url in urls.SelectMany(url => url.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
        {
            var port = PortOf(url);
            if (ports.Contains(port)) continue;
            if (servers.ContainsKey(port) || !Js.Listen(port))
            {
                Release();
                var error = new IOException($"Failed to bind to address {url}: address already in use.");
                HostCapture.StartFailed(error);
                throw error;
            }
            servers[port] = this;
            ports.Add(port);
            if (url.StartsWith("https:", StringComparison.OrdinalIgnoreCase)) Console.Error.WriteLine($"warn: {url} is served as plain HTTP: the browser runtime has no TLS.");
            addresses.Addresses.Add(url);
        }
        process = (reqId, features, response) => ProcessAsync(application, reqId, features, response);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        Release();
        return Task.CompletedTask;
    }

    public void Dispose() => Release();

    void Release()
    {
        process = null;
        foreach (var port in ports)
        {
            servers.Remove(port);
            Js.Unlisten(port);
        }
        ports.Clear();
    }

    internal static void Dispatch(int reqId, int port, string method, string url, string headersJson, byte[] body)
    {
        if (!servers.TryGetValue(port, out var server) || server.process is null)
        {
            Js.RespondHead(reqId, 502, "{}");
            Js.RespondEnd(reqId, null);
            return;
        }
        var aborted = new CancellationTokenSource();
        requests[reqId] = aborted;
        var response = new BrowserResponse(reqId, aborted.Token);
        var features = RequestFeatures(port, method, url, headersJson, body, response, aborted.Token);
        _ = server.process(reqId, features, response);
    }

    internal static void Cancel(int reqId)
    {
        if (requests.Remove(reqId, out var aborted)) aborted.Cancel();
    }

    static async Task ProcessAsync<TContext>(IHttpApplication<TContext> application, int reqId, IFeatureCollection features, BrowserResponse response) where TContext : notnull
    {
        var context = application.CreateContext(features);
        Exception? failure = null;
        try
        {
            await application.ProcessRequestAsync(context);
            await response.CompleteAsync();
        }
        catch (Exception error)
        {
            failure = error;
            await response.FailAsync(error);
        }
        finally
        {
            application.DisposeContext(context, failure);
            requests.Remove(reqId);
            await response.FireCompletedAsync();
        }
    }

    static FeatureCollection RequestFeatures(int port, string method, string url, string headersJson, byte[] body, BrowserResponse response, CancellationToken aborted)
    {
        var queryAt = url.IndexOf('?');
        var path = queryAt < 0 ? url : url[..queryAt];
        var request = new HttpRequestFeature
        {
            Protocol = "HTTP/1.1",
            Scheme = "http",
            Method = method,
            PathBase = "",
            Path = Uri.UnescapeDataString(path.Length == 0 ? "/" : path),
            QueryString = queryAt < 0 ? "" : url[queryAt..],
            RawTarget = url,
            Body = new MemoryStream(body, writable: false),
        };
        foreach (var (name, value) in JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson) ?? [])
            request.Headers.Append(name, value);
        if (!request.Headers.ContainsKey("Host")) request.Headers.Host = $"localhost:{port}";
        if (body.Length > 0 && !request.Headers.ContainsKey("Content-Length") && !request.Headers.ContainsKey("Transfer-Encoding"))
            request.Headers.ContentLength = body.Length;

        var features = new FeatureCollection();
        features.Set<IHttpRequestFeature>(request);
        features.Set<IHttpResponseFeature>(response);
        features.Set<IHttpResponseBodyFeature>(response);
        features.Set<IHttpRequestBodyDetectionFeature>(new BodyDetection(body.Length > 0 || request.Headers.ContainsKey("Transfer-Encoding")));
        features.Set<IHttpRequestLifetimeFeature>(new HttpRequestLifetimeFeature { RequestAborted = aborted });
        features.Set<IHttpRequestIdentifierFeature>(new HttpRequestIdentifierFeature());
        features.Set<IHttpConnectionFeature>(new HttpConnectionFeature
        {
            ConnectionId = $"bfwc-{nextConnection}",
            LocalIpAddress = IPAddress.Loopback,
            LocalPort = port,
            RemoteIpAddress = IPAddress.Loopback,
            RemotePort = 49152 + (nextConnection++ % 16384),
        });
        return features;
    }

    sealed class AddressesFeature : IServerAddressesFeature
    {
        public ICollection<string> Addresses { get; } = new List<string>();

        public bool PreferHostingUrls { get; set; }
    }

    sealed class BodyDetection(bool canHaveBody) : IHttpRequestBodyDetectionFeature
    {
        public bool CanHaveBody { get; } = canHaveBody;
    }
}
