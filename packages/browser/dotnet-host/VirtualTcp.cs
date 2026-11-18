// Outbound TCP on the runtime's virtual network: a Stream per dialled connection, its bytes relayed by the
// Worker (the process protocol's dial / dial-data / dial-close, as Node's net.connect and Python's sockets
// use). Npgsql opens its physical connections here (NpgsqlStreamTransport, patches/npgsql-browser.patch),
// so `Host=localhost;Port=5432` reaches the PGlite wire gateway. Only localhost is reachable.
//
// One thread, so reads cannot block: ReadAsync waits on the event loop, while a synchronous Read with
// nothing buffered throws (use Npgsql's async API: OpenAsync, ExecuteReaderAsync, …).
namespace Bfwc.Host;

internal static class VirtualTcp
{
    static readonly Dictionary<int, VirtualTcpStream> open = [];

    /// <summary>
    /// What arrived for a connection before its <see cref="ConnectAsync"/> continuation registered it: the Worker
    /// relays a server that speaks first (a greeting, a banner) as soon as the dial succeeds, while the id is still
    /// on its way back to .NET. Handed to the stream when it registers; nothing is lost.
    /// </summary>
    static readonly Dictionary<int, (List<byte[]> Chunks, bool Closed)> early = [];

    internal static bool IsLocal(string host) =>
        host is "localhost" or "0.0.0.0" or "::1" or "[::1]" || host.StartsWith("127.", StringComparison.Ordinal) || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);

    internal static async ValueTask<Stream> ConnectAsync(string host, int port, CancellationToken cancellationToken)
    {
        if (!IsLocal(host)) throw new IOException($"Cannot reach {host}:{port}: the browser runtime's network has localhost ports only.");
        var connId = await Js.Dial(port).WaitAsync(cancellationToken);
        if (connId < 0) throw new IOException($"Connection refused ({host}:{port}): nothing is listening on that port.");
        var stream = new VirtualTcpStream(connId);
        open[connId] = stream;
        if (early.Remove(connId, out var held))
        {
            foreach (var chunk in held.Chunks) stream.Push(chunk);
            if (held.Closed) Closed(connId);
        }
        return stream;
    }

    internal static void Received(int connId, byte[] data)
    {
        if (open.TryGetValue(connId, out var stream)) stream.Push(data);
        else Hold(connId).Chunks.Add(data);
    }

    internal static void Closed(int connId)
    {
        if (open.Remove(connId, out var stream)) stream.End();
        else if (early.TryGetValue(connId, out var held)) early[connId] = held with { Closed = true };
        else early[connId] = ([], true);
    }

    static (List<byte[]> Chunks, bool Closed) Hold(int connId)
    {
        if (!early.TryGetValue(connId, out var held)) early[connId] = held = ([], false);
        return held;
    }

    internal static void Forget(int connId)
    {
        open.Remove(connId);
        early.Remove(connId);
    }

    sealed class VirtualTcpStream(int connId) : Stream
    {
        readonly Queue<byte[]> chunks = new();
        int offset;
        bool ended;
        bool disposed;
        TaskCompletionSource? waiting;

        internal void Push(byte[] data)
        {
            if (data.Length == 0) return;
            chunks.Enqueue(data);
            waiting?.TrySetResult();
        }

        internal void End()
        {
            ended = true;
            waiting?.TrySetResult();
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        int Take(Span<byte> buffer)
        {
            var total = 0;
            while (total < buffer.Length && chunks.TryPeek(out var chunk))
            {
                var count = Math.Min(buffer.Length - total, chunk.Length - offset);
                chunk.AsSpan(offset, count).CopyTo(buffer[total..]);
                total += count;
                offset += count;
                if (offset == chunk.Length)
                {
                    chunks.Dequeue();
                    offset = 0;
                }
            }
            return total;
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            if (buffer.Length == 0 || chunks.Count > 0 || ended || disposed) return Take(buffer);
            throw new NotSupportedException("A synchronous read cannot wait in the browser runtime: use the async API (OpenAsync, ExecuteReaderAsync, ReadAsync …).");
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            while (buffer.Length > 0 && chunks.Count == 0 && !ended && !disposed)
            {
                waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                await waiting.Task.WaitAsync(cancellationToken);
                waiting = null;
            }
            return Take(buffer.Span);
        }

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (disposed || ended) throw new IOException("The connection is closed.");
            if (buffer.Length > 0) Js.Send(connId, buffer.ToArray());
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            Write(buffer.AsSpan(offset, count));
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Write(buffer.Span);
            return ValueTask.CompletedTask;
        }

        public override void Flush()
        {
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (!disposed)
            {
                disposed = true;
                Forget(connId);
                if (!ended) Js.HangUp(connId);
                waiting?.TrySetResult();
            }
            base.Dispose(disposing);
        }
    }
}
