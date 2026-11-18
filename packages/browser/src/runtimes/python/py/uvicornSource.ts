/**
 * Stand-ins for the app servers the runtime replaces, first on `sys.path`, so
 * `import uvicorn` works and `uvicorn.run(app)` (or `Server(Config(app)).run()`)
 * in a `__main__` block serves through the runtime: the call raises
 * `bfwc.serve.ServeRequested`, which unwinds the program like `SystemExit` —
 * code after the call never runs, as it would not until a real server stopped —
 * and the runtime serves the app on the requested port, request-driven.
 * `gunicorn` is importable (its `UvicornWorker` path included) but is never run.
 */
export const UVICORN_SOURCE = String.raw`
"""The browser runtime's uvicorn: run() serves the app on a virtual port, request-driven."""
from bfwc.serve import ServeRequested

__version__ = "0.0.0+bfwc"


class Config:
    def __init__(self, app, host="127.0.0.1", port=8000, factory=False, interface="auto", app_dir=None, lifespan="auto", **kwargs):
        if interface == "asgi2":
            raise ValueError("ASGI 2 (double-callable) apps are not supported by the browser runtime; use an ASGI 3 app.")
        self.app = app
        self.host = host
        self.port = int(port)
        self.factory = factory
        self.interface = "wsgi" if interface == "wsgi" else "asgi"
        self.app_dir = app_dir
        self.lifespan = lifespan


class Server:
    def __init__(self, config):
        self.config = config
        self.should_exit = False

    def run(self, sockets=None):
        config = self.config
        raise ServeRequested(config.interface, config.app, config.port, config.factory, config.app_dir, config.lifespan)

    async def serve(self, sockets=None):
        self.run(sockets)


def run(app, *, host="127.0.0.1", port=8000, factory=False, interface="auto", app_dir=None, lifespan="auto", **kwargs):
    Server(Config(app, host=host, port=port, factory=factory, interface=interface, app_dir=app_dir, lifespan=lifespan)).run()


def main():
    raise SystemExit("Run uvicorn from the command line (uvicorn module:app); the runtime reads that command line itself.")
`;

export const UVICORN_WORKERS_SOURCE = String.raw`
class UvicornWorker:
    """Named by gunicorn's -k option; the runtime reads it from the command line and serves ASGI."""
`;

export const GUNICORN_SOURCE = String.raw`
"""The browser runtime serves WSGI apps itself; gunicorn is importable but never runs."""
__version__ = "0.0.0+bfwc"
version_info = (0, 0, 0)
`;
