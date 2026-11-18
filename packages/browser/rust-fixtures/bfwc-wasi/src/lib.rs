//! The guest side of the BuilderForce WebContainers Rust ABI (the runtime's
//! `src/runtimes/rust/rustBridge.ts` is the host side).
//!
//! A service is a wasm32-wasip1 *reactor* (`crate-type = ["cdylib"]`): the host
//! instantiates it on its preview1 WASI host, runs `_initialize`, then calls the
//! app's `bfwc_start`, which calls [`serve`] with an axum `Router`. From then on
//! the host is in charge — the wasi:http-style handler model:
//!
//! - each HTTP request to the port arrives as `bfwc_request` (head + body),
//!   becomes a task running the router, and is answered with the `respond`
//!   import once the body is collected;
//! - the host calls `bfwc_poll` whenever something may have progressed (a
//!   request arrived, bytes arrived on a connection, a dial resolved); it polls
//!   every task until none was woken — nothing here ever blocks, so no threads,
//!   no `Atomics.wait`, no SharedArrayBuffer;
//! - [`net::connect`] dials a virtual port anywhere in the runtime (the Postgres
//!   gateway); [`net::TcpStream`] implements tokio's `AsyncRead`/`AsyncWrite`,
//!   so `tokio_postgres::Config::connect_raw` runs over it unchanged.
//!
//! tokio's own runtime is not used: its `block_on` parks the thread, which a
//! host that must return to the browser's event loop cannot allow. tokio's
//! I/O traits and sync primitives are runtime-agnostic and work here.

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Wake, Waker};

use tower::ServiceExt;

mod host {
    #[link(wasm_import_module = "bfwc")]
    extern "C" {
        #[link_name = "listen"]
        pub fn listen(port: u32) -> i32;
        #[link_name = "respond"]
        pub fn respond(request: u32, status: u32, head: *const u8, head_len: usize, body: *const u8, body_len: usize);
        #[link_name = "connect"]
        pub fn connect(port: u32) -> i32;
        #[link_name = "send"]
        pub fn send(handle: i32, data: *const u8, len: usize) -> i32;
        #[link_name = "recv"]
        pub fn recv(handle: i32, data: *mut u8, len: usize) -> i32;
        #[link_name = "close"]
        pub fn close(handle: i32);
    }
}

type Task = Pin<Box<dyn Future<Output = ()>>>;

thread_local! {
    static TASKS: RefCell<Vec<Task>> = const { RefCell::new(Vec::new()) };
    static SPAWNED: RefCell<Vec<Task>> = const { RefCell::new(Vec::new()) };
    static ROUTER: RefCell<Option<axum::Router>> = const { RefCell::new(None) };
}

static WOKEN: AtomicBool = AtomicBool::new(false);

struct Wakeup;

impl Wake for Wakeup {
    fn wake(self: Arc<Self>) {
        WOKEN.store(true, Ordering::SeqCst);
    }
}

/// The ABI this crate speaks (the runtime's `BFWC_ABI_VERSION`): a module built for another is declined.
pub const ABI_VERSION: u32 = 1;

#[no_mangle]
pub extern "C" fn bfwc_abi_version() -> u32 {
    ABI_VERSION
}

/// Run `future` on the host-driven executor (a `tokio_postgres::Connection`, say).
pub fn spawn(future: impl Future<Output = ()> + 'static) {
    SPAWNED.with(|spawned| spawned.borrow_mut().push(Box::pin(future)));
}

/// Passes per `bfwc_poll` before handing control back to the host (a task that wakes itself forever).
const MAX_PASSES: u32 = 1000;

/// Poll every task until none was woken and none was spawned. Answers 1 when work remains (the host polls again soon), else 0.
#[no_mangle]
pub extern "C" fn bfwc_poll() -> u32 {
    let waker = Waker::from(Arc::new(Wakeup));
    let mut cx = Context::from_waker(&waker);
    for _ in 0..MAX_PASSES {
        WOKEN.store(false, Ordering::SeqCst);
        let mut tasks = TASKS.with(|tasks| std::mem::take(&mut *tasks.borrow_mut()));
        tasks.append(&mut SPAWNED.with(|spawned| std::mem::take(&mut *spawned.borrow_mut())));
        tasks.retain_mut(|task| task.as_mut().poll(&mut cx).is_pending());
        TASKS.with(|kept| kept.borrow_mut().append(&mut tasks));
        let spawned = SPAWNED.with(|spawned| !spawned.borrow().is_empty());
        if !spawned && !WOKEN.load(Ordering::SeqCst) {
            return 0;
        }
    }
    1
}

/// Memory for the host to write a request into; `bfwc_request` takes ownership of it.
#[no_mangle]
pub extern "C" fn bfwc_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Serve `router` on virtual `port`. Fails when another process holds the port.
pub fn serve(port: u16, router: axum::Router) -> Result<(), String> {
    if unsafe { host::listen(port as u32) } != 0 {
        return Err(format!("Error: Address already in use (os error 98): 0.0.0.0:{port}"));
    }
    ROUTER.with(|slot| *slot.borrow_mut() = Some(router));
    Ok(())
}

fn respond(request: u32, status: u16, head: &str, body: &[u8]) {
    unsafe { host::respond(request, status as u32, head.as_ptr(), head.len(), body.as_ptr(), body.len()) }
}

/// One HTTP request: `head` is `METHOD SP URL` then `name:value` lines (`\n`-separated); both buffers came from `bfwc_alloc`.
///
/// # Safety
/// `head`/`body` must be `bfwc_alloc` allocations of exactly `head_len`/`body_len` bytes, written in full.
#[no_mangle]
pub unsafe extern "C" fn bfwc_request(request: u32, head: *mut u8, head_len: usize, body: *mut u8, body_len: usize) {
    let head = Vec::from_raw_parts(head, head_len, head_len);
    let body = Vec::from_raw_parts(body, body_len, body_len);
    let Some(router) = ROUTER.with(|slot| slot.borrow().clone()) else {
        return respond(request, 503, "content-type:text/plain", b"The service is not serving.");
    };
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split('\n');
    let (method, url) = lines.next().and_then(|line| line.split_once(' ')).unwrap_or(("GET", "/"));
    let mut builder = axum::http::Request::builder().method(method).uri(url);
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            builder = builder.header(name, value);
        }
    }
    let http_request = match builder.body(axum::body::Body::from(body)) {
        Ok(http_request) => http_request,
        Err(error) => return respond(request, 400, "content-type:text/plain", error.to_string().as_bytes()),
    };
    spawn(async move {
        let response = match router.oneshot(http_request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
        let (parts, body) = response.into_parts();
        match axum::body::to_bytes(body, usize::MAX).await {
            Ok(bytes) => {
                let mut head = String::new();
                for (name, value) in &parts.headers {
                    if let Ok(value) = value.to_str() {
                        head.push_str(name.as_str());
                        head.push(':');
                        head.push_str(value);
                        head.push('\n');
                    }
                }
                respond(request, parts.status.as_u16(), head.trim_end(), &bytes);
            }
            Err(error) => respond(request, 500, "content-type:text/plain", error.to_string().as_bytes()),
        }
    });
}

/// Virtual TCP: connections to ports anywhere in the runtime.
pub mod net {
    use super::host;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    const WOULD_BLOCK: i32 = -1;
    const REFUSED: i32 = -2;

    /// A connection to a virtual port. Reads are pending until the host has bytes; writes are pending while too much is in flight
    /// (the host holds writes until the dial resolves). No half-close: `poll_shutdown` is a no-op and dropping the stream hangs up.
    pub struct TcpStream {
        handle: i32,
    }

    /// Dial `port`. The dial resolves in the background: a port nothing listens on fails the first read with `ConnectionRefused`.
    pub fn connect(port: u16) -> io::Result<TcpStream> {
        let handle = unsafe { host::connect(port as u32) };
        if handle < 0 {
            return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("connection to port {port} refused")));
        }
        Ok(TcpStream { handle })
    }

    fn failure(code: i32) -> io::Error {
        if code == REFUSED {
            io::Error::new(io::ErrorKind::ConnectionRefused, "connection refused")
        } else {
            io::Error::new(io::ErrorKind::ConnectionReset, "connection reset")
        }
    }

    impl AsyncRead for TcpStream {
        fn poll_read(self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            let unfilled = buf.initialize_unfilled();
            let read = unsafe { host::recv(self.handle, unfilled.as_mut_ptr(), unfilled.len()) };
            match read {
                // The host polls again when bytes arrive.
                WOULD_BLOCK => Poll::Pending,
                code if code < 0 => Poll::Ready(Err(failure(code))),
                count => {
                    buf.advance(count as usize);
                    Poll::Ready(Ok(()))
                }
            }
        }
    }

    impl AsyncWrite for TcpStream {
        fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
            let sent = unsafe { host::send(self.handle, data.as_ptr(), data.len()) };
            match sent {
                // Over the high-water mark: the host polls again when the reader has caught up.
                WOULD_BLOCK => Poll::Pending,
                code if code < 0 => Poll::Ready(Err(failure(code))),
                count => Poll::Ready(Ok(count as usize)),
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl Drop for TcpStream {
        fn drop(&mut self) {
            unsafe { host::close(self.handle) }
        }
    }
}
