// One response of the in-memory server, streamed to the Worker: the head when the response starts
// (OnStarting callbacks first, last registered first, as Kestrel runs them), each written chunk as it is
// written or flushed, then the end. A request the client hung up on (CancelRequest) drops what follows.
using System.IO.Pipelines;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Bfwc.Host;

internal sealed class BrowserResponse : IHttpResponseFeature, IHttpResponseBodyFeature
{
    readonly int reqId;
    readonly CancellationToken aborted;
    readonly List<(Func<object, Task> Callback, object State)> starting = [];
    readonly List<(Func<object, Task> Callback, object State)> completed = [];
    readonly ChunkStream stream;
    PipeWriter? writer;
    bool ended;

    internal BrowserResponse(int reqId, CancellationToken aborted)
    {
        this.reqId = reqId;
        this.aborted = aborted;
        stream = new ChunkStream(this);
        Body = stream;
    }

    public int StatusCode { get; set; } = 200;

    public string? ReasonPhrase { get; set; }

    public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();

    public Stream Body { get; set; }

    public bool HasStarted { get; private set; }

    public Stream Stream => stream;

    public PipeWriter Writer => writer ??= PipeWriter.Create(stream, new StreamPipeWriterOptions(leaveOpen: true));

    public void OnStarting(Func<object, Task> callback, object state) => starting.Add((callback, state));

    public void OnCompleted(Func<object, Task> callback, object state) => completed.Add((callback, state));

    public void DisableBuffering()
    {
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (HasStarted) return;
        for (var i = starting.Count - 1; i >= 0; i--) await starting[i].Callback(starting[i].State);
        HasStarted = true;
        if (aborted.IsCancellationRequested) return;
        var headers = Headers.ToDictionary(header => header.Key, header => header.Value.Select(value => value ?? "").ToArray(), StringComparer.OrdinalIgnoreCase);
        Js.RespondHead(reqId, StatusCode, JsonSerializer.Serialize(headers));
    }

    public async Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
    {
        await using var file = File.OpenRead(path);
        file.Seek(offset, SeekOrigin.Begin);
        var remaining = count ?? file.Length - offset;
        var buffer = new byte[Math.Min(remaining, 64 * 1024)];
        while (remaining > 0)
        {
            var read = await file.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), cancellationToken);
            if (read == 0) break;
            await stream.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            remaining -= read;
        }
    }

    public async Task CompleteAsync()
    {
        if (ended) return;
        if (writer is not null) await writer.CompleteAsync();
        await StartAsync();
        End(null);
    }

    /// <summary>The pipeline threw: a 500 when nothing was sent yet, else the response ends in error.</summary>
    internal async Task FailAsync(Exception error)
    {
        if (ended) return;
        Console.Error.WriteLine($"fail: Microsoft.AspNetCore.Server.Browser[0] An unhandled exception was thrown by the application.\n{error}");
        if (!HasStarted)
        {
            starting.Clear();
            StatusCode = 500;
            Headers.Clear();
            Headers.ContentLength = 0;
            await StartAsync();
            End(null);
        }
        else End(error.Message);
    }

    internal async Task FireCompletedAsync()
    {
        for (var i = completed.Count - 1; i >= 0; i--)
        {
            try
            {
                await completed[i].Callback(completed[i].State);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"fail: an OnCompleted callback threw: {error}");
            }
        }
    }

    void End(string? error)
    {
        ended = true;
        if (!aborted.IsCancellationRequested) Js.RespondEnd(reqId, error);
    }

    void Send(ReadOnlySpan<byte> data)
    {
        if (ended) throw new InvalidOperationException("The response has completed.");
        if (data.Length > 0 && !aborted.IsCancellationRequested) Js.RespondChunk(reqId, data.ToArray());
    }

    /// <summary>The response body: writes start the response (async writes run OnStarting first) and go out as chunks.</summary>
    sealed class ChunkStream(BrowserResponse response) : Stream
    {
        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (!response.HasStarted) response.StartAsync().GetAwaiter().GetResult();
            response.Send(buffer);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await response.StartAsync(cancellationToken);
            response.Send(buffer.Span);
        }

        public override void Flush()
        {
            if (!response.HasStarted) response.StartAsync().GetAwaiter().GetResult();
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => response.StartAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
