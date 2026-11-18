/**
 * The JavaScript side of request-driven Python serving: start the app
 * (`bfwc.serve.start_server` — import it, run the ASGI lifespan startup — or
 * `start_requested`, for a program that called `uvicorn.run`), then answer each
 * virtual-port request by calling it and rebuilding its answer as a streamed
 * `HttpStreamResponse`: the head as soon as the app sends it, the body chunk by
 * chunk, with backpressure (an ASGI `send` waits while the reader is behind).
 * A reader that hangs up is an ASGI `http.disconnect`. This is an
 * `HttpHandler`, so anything that routes a port to a handler can serve it.
 */
import { pushStream, type HttpHandler, type HttpRequestData, type HttpStreamResponse, type PushStream } from '@seanhogg/builderforce-webcontainers-core';
import type { AppInterface, AppServerSpec } from './pythonCommand.js';
import type { PyodideLike, PyProxyLike } from './pyodideLoader.js';

export interface PythonAppServer {
  readonly spec: AppServerSpec;
  /** Serve one request. */
  readonly handle: HttpHandler;
  /** Run the ASGI lifespan shutdown (when the app spoke lifespan). */
  close(): Promise<void>;
}

/** The JavaScript responder the Python side answers through. */
interface Responder {
  head(status: number, headersJson: string): void;
  /** A promise while the reader is behind (the app should wait on it), else nothing. */
  chunk(data: Uint8Array): Promise<void> | undefined;
  end(error?: string | null): void;
}

type HandleFn = (reqId: number, method: string, target: string, headersJson: string, body: Uint8Array | undefined, respond: Responder) => Promise<unknown>;

/** `[name, value]` pairs as a head's headers; repeated names (Set-Cookie) become arrays. */
export function headersOf(pairs: ReadonlyArray<readonly [string, string]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    const existing = out[name];
    out[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

/** The request's headers as `[name, value]` pairs, for the Python side. */
const headerPairs = (request: HttpRequestData) => JSON.stringify(Object.entries(request.headers ?? {}));

/** A started `bfwc.serve.Server` as an `HttpHandler`. */
function serving(server: PyProxyLike): PythonAppServer {
  const handleFn = server.handle as HandleFn;
  const disconnect = server.disconnect as (reqId: number) => void;
  const closeFn = server.close as () => Promise<unknown>;
  const spec: AppServerSpec = { interface: server.interface as AppInterface, app: String(server.label), port: Number(server.port) };
  let nextReq = 1;

  const handle: HttpHandler = (request) =>
    new Promise<HttpStreamResponse>((resolve, reject) => {
      const reqId = nextReq++;
      let body: PushStream | undefined;
      let finished = false;
      const respond: Responder = {
        head(status, headersJson) {
          body = pushStream(() => {
            if (!finished) disconnect(reqId);
          });
          resolve({ status, headers: headersOf(JSON.parse(headersJson) as Array<[string, string]>), body: body.stream });
        },
        chunk(data) {
          if (!body || body.push(data.slice())) return undefined;
          return body.ready();
        },
        end(error) {
          finished = true;
          if (error) body?.fail(new Error(error));
          else body?.end();
        },
      };
      // `undefined`, not `null`: Pyodide hands JavaScript null to Python as `jsnull`, not None.
      handleFn(reqId, request.method, request.url, headerPairs(request), request.body ?? undefined, respond).then(
        () => {
          if (!body) reject(new Error('The Python app finished without a response.'));
        },
        (error: unknown) => {
          if (body) body.fail(error);
          else reject(error);
        },
      );
    });

  return {
    spec,
    handle,
    async close() {
      try {
        await closeFn();
      } finally {
        server.destroy?.();
      }
    },
  };
}

/** Start serving `spec` in this interpreter (cwd already the service's root). */
export async function startPythonAppServer(pyodide: PyodideLike, spec: AppServerSpec): Promise<PythonAppServer> {
  const startServer = pyodide.pyimport('bfwc.serve').start_server as (iface: string, app: string, port: number, factory: boolean, appDir: string | undefined) => Promise<PyProxyLike>;
  return serving(await startServer(spec.interface, spec.app, spec.port, !!spec.factory, spec.appDir));
}

/** Start serving the app a program asked for (`uvicorn.run(app)` → `run_main` returned `"serve"`). */
export async function startRequestedAppServer(pyodide: PyodideLike): Promise<PythonAppServer> {
  const startRequested = pyodide.pyimport('bfwc.serve').start_requested as () => Promise<PyProxyLike>;
  return serving(await startRequested());
}
