/**
 * `bfwc/vsocket.py`: Python sockets over the runtime's virtual TCP (the
 * transport a host registers as the JS module `_bfwc_tcp`; see
 * virtualSocket.ts). Two faces over the same transport:
 *
 * - **Blocking** (`VirtualSocket`, `create_connection`, and `socket.socket`
 *   itself once installed): the stream-socket surface blocking drivers use —
 *   pg8000 (`create_connection` → `makefile("rwb")`), redis-py
 *   (`getaddrinfo` → `socket.socket()` → `connect`). Each wait on a transport
 *   promise goes through `pyodide.ffi.run_sync`: JSPI stack switching, no
 *   SharedArrayBuffer. Timeouts and non-blocking mode are honoured
 *   (`socket.timeout`, `BlockingIOError`). Without JSPI on the current call
 *   path, blocking calls raise `BlockingIOError` naming the asyncio face.
 * - **asyncio** (`open_connection`): a `StreamReader`/`StreamWriter`-shaped pair
 *   awaiting the same promises; works everywhere Pyodide runs.
 */
export const SOCKET_SOURCE = String.raw`
import asyncio
import errno as _errno
import io
import socket as _socket

from pyodide.ffi import to_js

try:
    from pyodide.ffi import can_run_sync, run_sync
except ImportError:  # an older Pyodide
    def can_run_sync():
        return False

    def run_sync(awaitable):
        raise RuntimeError("run_sync is unavailable")

_original_socket = _socket.socket
_TIMEOUT = "timeout"


def _transport():
    import _bfwc_tcp

    return _bfwc_tcp


def _bytes(chunk):
    return b"" if chunk is None else chunk.to_bytes()


def _block(awaitable):
    if can_run_sync():
        return run_sync(awaitable)
    raise BlockingIOError(
        "Blocking sockets need JSPI (WebAssembly stack switching), which this browser or call path lacks; "
        "use bfwc.vsocket.open_connection() from asyncio code instead."
    )


def _ms(timeout):
    return None if timeout is None else int(timeout * 1000)


def _refused(host, port, error):
    message = str(error)
    if "timed out" in message:
        return _socket.timeout("timed out connecting to %s:%d" % (host, port))
    return ConnectionRefusedError(_errno.ECONNREFUSED, "Connection refused (%s:%d): %s" % (host, port, message))


class _SocketIO(io.RawIOBase):
    def __init__(self, sock):
        self._sock = sock

    def readable(self):
        return True

    def writable(self):
        return True

    def readinto(self, buffer):
        return self._sock.recv_into(buffer)

    def write(self, data):
        self._sock.sendall(data)
        return len(data)


class VirtualSocket:
    """A stream socket on the virtual network (AF_INET/AF_INET6, SOCK_STREAM)."""

    def __init__(self, family=_socket.AF_INET, type=_socket.SOCK_STREAM, proto=0, fileno=None):
        self.family, self.type, self.proto = family, type, proto
        self._conn = None
        self._peer = None
        self._pending = b""
        self._timeout = _socket.getdefaulttimeout()
        self._read_closed = False
        self._write_closed = False

    # connection
    def connect(self, address):
        host, port = str(address[0]), int(address[1])
        try:
            self._conn = _block(_transport().connect(host, port, _ms(self._timeout)))
        except BlockingIOError:
            raise
        except Exception as error:
            raise _refused(host, port, error) from None
        self._peer = (host, port)

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except OSError as error:
            return error.errno or _errno.ECONNREFUSED

    def close(self):
        if self._conn is not None:
            _transport().close(self._conn)
            self._conn = None

    def shutdown(self, how):
        self._check()
        if how in (_socket.SHUT_RD, _socket.SHUT_RDWR):
            self._read_closed = True
        if how in (_socket.SHUT_WR, _socket.SHUT_RDWR):
            self._write_closed = True
            # A real half-close when the transport has one; else the peer hears nothing until close().
            _transport().shutdown(self._conn)
        if how == _socket.SHUT_RDWR:
            self.close()

    def detach(self):
        conn, self._conn = self._conn, None
        return -1 if conn is None else conn

    def _check(self):
        if self._conn is None:
            raise OSError(_errno.EBADF, "Bad file descriptor")

    # data
    def sendall(self, data, flags=0):
        self._check()
        if self._write_closed:
            raise BrokenPipeError(_errno.EPIPE, "Broken pipe")
        _block(_transport().send(self._conn, to_js(bytes(data))))

    def send(self, data, flags=0):
        self.sendall(data)
        return len(data)

    def recv(self, bufsize, flags=0):
        self._check()
        if self._read_closed:
            return b""
        if not self._pending:
            chunk = _block(_transport().recv(self._conn, bufsize, _ms(self._timeout)))
            if isinstance(chunk, str) and chunk == _TIMEOUT:
                if self._timeout == 0:
                    raise BlockingIOError(_errno.EAGAIN, "Resource temporarily unavailable")
                raise _socket.timeout("timed out")
            self._pending = _bytes(chunk)
        data, self._pending = self._pending[:bufsize], self._pending[bufsize:]
        return data

    def recv_into(self, buffer, nbytes=0, flags=0):
        view = memoryview(buffer)
        data = self.recv(nbytes or len(view))
        view[: len(data)] = data
        return len(data)

    def makefile(self, mode="r", buffering=None, *, encoding=None, errors=None, newline=None):
        raw = _SocketIO(self)
        if "r" in mode and "w" in mode:
            stream = io.BufferedRWPair(raw, raw)
        elif "w" in mode:
            stream = io.BufferedWriter(raw)
        else:
            stream = io.BufferedReader(raw)
        return stream if "b" in mode else io.TextIOWrapper(stream, encoding=encoding, errors=errors, newline=newline)

    # timeouts: None blocks, 0.0 is non-blocking, t > 0 waits t seconds
    def settimeout(self, value):
        self._timeout = None if value is None else float(value)

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def getblocking(self):
        return self._timeout != 0.0

    # options, accepted and ignored: there is no kernel socket underneath
    def setsockopt(self, *args):
        pass

    def getsockopt(self, *args):
        return 0

    def getpeername(self):
        return self._peer

    def getsockname(self):
        return ("127.0.0.1", 0)

    def fileno(self):
        return -1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _Socket(VirtualSocket):
    """What socket.socket becomes: virtual for TCP, the original for everything else."""

    def __new__(cls, family=_socket.AF_INET, type=_socket.SOCK_STREAM, proto=0, fileno=None):
        if fileno is None and family in (_socket.AF_INET, _socket.AF_INET6) and type & _socket.SOCK_STREAM:
            return super().__new__(cls)
        return _original_socket(family, type, proto, fileno)


def create_connection(address, timeout=_socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **kwargs):
    sock = VirtualSocket()
    if timeout is not _socket._GLOBAL_DEFAULT_TIMEOUT:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    """One IPv4 stream address for the host as given; the transport decides whether it is reachable (localhost only)."""
    try:
        number = int(port or 0)
    except (TypeError, ValueError):
        number = _socket.getservbyname(port) if isinstance(port, str) else 0
    return [(_socket.AF_INET, _socket.SOCK_STREAM, _socket.IPPROTO_TCP, "", (host or "localhost", number))]


class VirtualStreamReader:
    def __init__(self, conn):
        self._conn = conn
        self._buffer = b""
        self._eof = False

    async def _fill(self, size):
        if self._eof:
            return False
        chunk = _bytes(await _transport().recv(self._conn, size, None))
        if not chunk:
            self._eof = True
            return False
        self._buffer += chunk
        return True

    async def read(self, n=-1):
        if not self._buffer:
            await self._fill(65536 if n < 0 else n)
        if n < 0:
            while await self._fill(65536):
                pass
            n = len(self._buffer)
        data, self._buffer = self._buffer[:n], self._buffer[n:]
        return data

    async def readexactly(self, n):
        while len(self._buffer) < n:
            if not await self._fill(n - len(self._buffer)):
                raise asyncio.IncompleteReadError(self._buffer, n)
        data, self._buffer = self._buffer[:n], self._buffer[n:]
        return data

    async def readline(self):
        while b"\n" not in self._buffer and await self._fill(65536):
            pass
        index = self._buffer.find(b"\n")
        end = len(self._buffer) if index < 0 else index + 1
        data, self._buffer = self._buffer[:end], self._buffer[end:]
        return data

    def at_eof(self):
        return self._eof and not self._buffer


class VirtualStreamWriter:
    def __init__(self, conn):
        self._conn = conn
        self._queued = []
        self._closing = None

    def write(self, data):
        if self._closing is not None:
            raise ConnectionResetError("The writer is closed.")
        self._queued.append(bytes(data))

    async def drain(self):
        while self._queued:
            await _transport().send(self._conn, to_js(self._queued.pop(0)))

    async def _finish(self):
        try:
            await self.drain()
        finally:
            _transport().close(self._conn)

    def close(self):
        """Close once everything written so far is sent."""
        if self._closing is None:
            self._closing = asyncio.ensure_future(self._finish())

    async def wait_closed(self):
        if self._closing is not None:
            await self._closing

    def is_closing(self):
        return self._closing is not None


async def open_connection(host, port):
    try:
        conn = await _transport().connect(str(host), int(port), None)
    except Exception as error:
        raise _refused(str(host), int(port), error) from None
    return VirtualStreamReader(conn), VirtualStreamWriter(conn)


def install():
    """Route TCP sockets to the virtual transport: create_connection (pg8000), socket.socket + getaddrinfo (redis-py)."""
    _socket.create_connection = create_connection
    _socket.socket = _Socket
    _socket.getaddrinfo = getaddrinfo
`;
