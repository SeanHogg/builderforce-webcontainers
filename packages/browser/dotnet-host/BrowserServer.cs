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

    /// <summary>
    /// Claim every configured URL's port. Any failure — a URL that does not parse (ASPNETCORE_URLS without a
    /// scheme), port 0, a port another process holds — releases what was claimed, leaves no URL behind in
    /// <see cref="IServerAddressesFeature"/>, and is reported to <see cref="HostCapture"/> so a program blocked
    /// in <c>app.Run()</c> ends instead of waiting on a host that never started.
    /// </summary>
    public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull
    {
        try
        {
            var urls = addresses.Addresses.Count > 0 ? addresses.Addresses.ToList() : [DefaultUrl];
            addresses.Addresses.Clear();
            foreach (var url in urls.SelectMany(url => url.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
            {
                var port = PortOf(url);
                if (port == 0) throw new InvalidOperationException($"Dynamic port binding is not supported by the browser runtime: {url} names port 0. Use a fixed port.");
                if (ports.Contains(port)) continue;
                if (servers.ContainsKey(port) || !Js.Listen(port)) throw new IOException($"Failed to bind to address {url}: address already in use.");
                servers[port] = this;
                ports.Add(port);
                if (url.StartsWith("https:", StringComparison.OrdinalIgnoreCase)) Console.Error.WriteLine($"warn: {url} is served as plain HTTP: the browser runtime has no TLS.");
                addresses.Addresses.Add(url);
            }
            process = (reqId, features, response) => ProcessAsync(application, reqId, features, response);
            return Task.CompletedTask;
        }
        catch (Exception error)
        {
            Release();
            addresses.Addresses.Clear();
            HostCapture.StartFailed(error);
            throw;
        }
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
            Path = DecodePath(path.Length == 0 ? "/" : path),
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

    /// <summary>
    /// A request target's path as Kestrel gives it to the pipeline: percent-escapes decoded as UTF-8 except
    /// <c>%2F</c> (an encoded slash stays <c>%2F</c>, so it never splits a segment), then dot segments removed
    /// (RFC 3986 §5.2.4) — after decoding, so <c>%2e%2e</c> cannot climb out either. Bytes that are not
    /// UTF-8 keep their escapes.
    /// </summary>
    internal static string DecodePath(string raw)
    {
        var bytes = new List<byte>(raw.Length);
        var i = 0;
        while (i < raw.Length)
        {
            if (raw[i] == '%' && i + 2 < raw.Length && Uri.IsHexDigit(raw[i + 1]) && Uri.IsHexDigit(raw[i + 2]))
            {
                var value = (byte)Convert.ToInt32(raw.Substring(i + 1, 2), 16);
                if (value == (byte)'/') bytes.AddRange("%2F"u8.ToArray());
                else bytes.Add(value);
                i += 3;
                continue;
            }
            // Literal text up to the next escape, encoded whole (surrogate pairs stay together).
            var next = raw.IndexOf('%', i + 1);
            var end = next < 0 ? raw.Length : next;
            bytes.AddRange(System.Text.Encoding.UTF8.GetBytes(raw[i..end]));
            i = end;
        }
        string decoded;
        try
        {
            decoded = new System.Text.UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes.ToArray());
        }
        catch (System.Text.DecoderFallbackException)
        {
            decoded = raw;
        }
        return RemoveDotSegments(decoded);
    }

    /// <summary>RFC 3986 §5.2.4 on an absolute path: <c>/a/./b/../c</c> → <c>/a/c</c>; never above <c>/</c>.</summary>
    internal static string RemoveDotSegments(string path)
    {
        if (!path.StartsWith('/')) path = "/" + path;
        var output = new List<string>();
        var segments = path.Split('/');
        for (var i = 1; i < segments.Length; i++)
        {
            var segment = segments[i];
            var last = i == segments.Length - 1;
            if (segment == ".")
            {
                if (last) output.Add("");
            }
            else if (segment == "..")
            {
                if (output.Count > 0) output.RemoveAt(output.Count - 1);
                if (last) output.Add("");
            }
            else output.Add(segment);
        }
        return "/" + string.Join('/', output);
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
