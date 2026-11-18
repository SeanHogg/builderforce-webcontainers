/**
 * `bfwc/threads.py`: Pyodide has no threads, so work frameworks hand to a
 * thread pool runs inline on the event loop instead — FastAPI/Starlette's sync
 * endpoints (`anyio.to_thread.run_sync`) and `asyncio.to_thread`. The work
 * blocks the loop while it runs (as it would block a one-thread pool). Calls
 * back from such work into the loop (`anyio.from_thread.run`/`run_sync`) would
 * deadlock, so they raise a clear error instead.
 */
export const THREADS_SOURCE = String.raw`
import asyncio
import sys

NO_THREADS = (
    "anyio.from_thread is unavailable in the browser runtime: Pyodide has no threads, "
    "so to_thread work runs inline on the event loop and cannot wait for it. Make the caller async instead."
)


async def _asyncio_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


async def _anyio_run_sync(func, *args, abandon_on_cancel=False, cancellable=None, limiter=None):
    return func(*args)


def _no_from_thread(*args, **kwargs):
    raise RuntimeError(NO_THREADS)


def install():
    asyncio.to_thread = _asyncio_to_thread
    try:
        import anyio.to_thread
        import anyio.from_thread
    except ImportError:
        return
    anyio.to_thread.run_sync = _anyio_run_sync
    anyio.from_thread.run = _no_from_thread
    anyio.from_thread.run_sync = _no_from_thread
`;
