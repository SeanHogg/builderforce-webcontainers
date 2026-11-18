/**
 * The worker side of one interpreted-language process — what the Python
 * (Pyodide), PHP (php-wasm) and .NET (Mono) process Workers share. It speaks the process
 * Workers' protocol (node/protocol.ts), so the page's process host drives it
 * like any other process:
 *
 * - `prime`/`start` mount the project from the shared snapshot pack into a
 *   staging VFS (`mountSnapshot`/`applyOps`) until the interpreter takes it
 *   over (`mounted`); page `fs` ops land in whichever holds it;
 * - stdout/stderr are posted until the exit; `exit` first flushes the
 *   interpreter's pending writes and unlistens the port it served;
 * - a served app's port is checked against the runtime's port table before the
 *   interpreter boots and again after (another process may have taken it
 *   meanwhile) — both fail like the language's own server (EADDRINUSE) — then
 *   announced with `listen`, and its requests answered through
 *   node/servedPorts.ts; a `listen-failed` ends the process. A program that
 *   claims ports itself while it runs (.NET's ASP.NET Core host) is a
 *   {@link DynamicPorts} outcome instead: the same routing, unlisten and
 *   listen-failed handling over whatever ports it holds;
 * - `kill` closes the server and exits with the signal's code; WebSocket and
 *   raw-TCP connections to the process are refused.
 *
 * What differs per language — parsing the command line, booting, running,
 * standard input, the address-in-use message — is the {@link InterpreterRuntime}.
 */
import { VirtualFileSystem, applyOps, mountSnapshot, signalExitCode, type HttpHandler, type StdioChunk, type VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, StartMessage, WorkerToHost } from '../node/protocol.js';
import { createServedPorts } from '../node/servedPorts.js';

/** A served app: its port, its request handler, and how it shuts down. */
export interface InterpreterServer {
  readonly port: number;
  readonly handle: HttpHandler;
  close(): Promise<void>;
}

/**
 * A program that claims and releases ports itself while it runs (an ASP.NET
 * Core host: any number of URLs, bound when the host starts). It announces its
 * own `listen`/`unlisten` (checking `takenPorts`); the skeleton routes requests
 * to `handlerFor`, unlistens what is still `listening` at the exit, and ends
 * the process when the program's `done` settles.
 */
export interface DynamicPorts {
  readonly listening: ReadonlySet<number>;
  handlerFor(port: number): HttpHandler | undefined;
  /** Ask the program to stop (a kill): best effort, the exit follows at once. */
  stop(): void;
  /** Fail what is still in flight (the process is ending). */
  closeAll(): void;
}

export type InterpreterOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'serving'; server: InterpreterServer; banner: string }
  | { kind: 'running'; ports: DynamicPorts; done: Promise<number> };

/** The interpreter's project once it holds it: page ops go here, and its own pending writes are flushed before an exit. */
export interface MountedProject {
  apply(ops: readonly VfsOp[]): void;
  flush(): void;
}

export interface InterpreterContext {
  post(message: WorkerToHost): void;
  readonly io: { stdout(data: StdioChunk): void; stderr(data: StdioChunk): void };
  /** Whether the process has exited (killed while the interpreter loaded). */
  readonly exited: boolean;
  exit(code: number): void;
  /** The interpreter took over the project: `staging`'s files are copied in; later ops go to `project`. */
  mounted(project: MountedProject): void;
  /** Ports taken anywhere in the runtime, as this process knows them (a {@link DynamicPorts} program claims its own here). */
  readonly takenPorts: Set<number>;
}

/** What the command line asks for: refused (with the language's message and exit code), or a run — serving `port` when known before booting. */
export type InterpreterPlan = { ok: false; message: string; code: number } | { ok: true; port?: number; run(staging: VirtualFileSystem): Promise<InterpreterOutcome> };

export interface InterpreterRuntime {
  plan(message: StartMessage): InterpreterPlan;
  /** The language's message when `port` is taken (stderr, with its newline). */
  addressInUse(port: number): string;
  /** Standard input arrived (`null`: end of file). Default: ignored. */
  stdin?(data: StdioChunk | null): void;
  /** Messages the runtime takes itself (its dialled connections); true when taken. */
  receive?(message: HostToWorker): boolean;
}

export function createInterpreterProcess(post: (message: WorkerToHost) => void, create: (context: InterpreterContext) => InterpreterRuntime): { receive(message: HostToWorker): void } {
  let staging: VirtualFileSystem | undefined = new VirtualFileSystem();
  let project: MountedProject | undefined;
  let server: InterpreterServer | undefined;
  let serverPort: number | undefined;
  let dynamic: DynamicPorts | undefined;
  let exited = false;

  const exit = (code: number) => {
    if (exited) return;
    project?.flush(); // every write reaches the page before the exit does
    exited = true;
    if (serverPort !== undefined) post({ type: 'unlisten', port: serverPort });
    for (const port of dynamic?.listening ?? []) post({ type: 'unlisten', port });
    dynamic?.closeAll();
    post({ type: 'exit', code });
  };
  const context: InterpreterContext = {
    post,
    io: {
      stdout: (data) => !exited && post({ type: 'stdout', data }),
      stderr: (data) => !exited && post({ type: 'stderr', data }),
    },
    get exited() {
      return exited;
    },
    exit,
    mounted(mounted) {
      staging = undefined;
      project = mounted;
    },
    get takenPorts() {
      return served.taken;
    },
  };
  const stop = async (signal: string, code = signalExitCode(signal)) => {
    const running = server;
    server = undefined;
    served.cancelAll();
    try {
      dynamic?.stop();
    } catch {
      // Stopping is best effort: the Worker is terminated after the exit.
    }
    try {
      await running?.close();
    } finally {
      exit(code);
    }
  };
  const served = createServedPorts({
    post,
    handlerFor: (port) => (server && port === serverPort ? server.handle : dynamic?.handlerFor(port)),
    onListenFailed(port) {
      if (port === serverPort) serverPort = undefined; // never ours: nothing to unlisten
      else if (!dynamic?.listening.has(port)) return;
      context.io.stderr(runtime.addressInUse(port));
      void stop('SIGTERM', 1);
    },
  });
  // After `served`: a runtime may read `takenPorts` while it is created.
  const runtime = create(context);
  const applyIncoming = (ops: readonly VfsOp[]) => {
    if (staging) applyOps(staging, ops);
    else project?.apply(ops);
  };

  async function start(message: StartMessage): Promise<void> {
    const { snapshot } = message;
    if (snapshot.pack) mountSnapshot(staging!, snapshot);
    else applyIncoming(snapshot.ops);
    for (const port of message.ports) served.taken.add(port);
    const plan = runtime.plan(message);
    if (!plan.ok) {
      context.io.stderr(plan.message);
      return exit(plan.code);
    }
    if (plan.port !== undefined && served.taken.has(plan.port)) {
      context.io.stderr(runtime.addressInUse(plan.port));
      return exit(1);
    }
    const outcome = await plan.run(staging!);
    if (outcome.kind === 'exited') return exit(outcome.code);
    if (outcome.kind === 'running') {
      dynamic = outcome.ports;
      return exit(await outcome.done);
    }
    const { port } = outcome.server;
    // Another process may have taken the port while this one booted (the page tells every process).
    if (exited || served.taken.has(port)) {
      await outcome.server.close();
      if (!exited) context.io.stderr(runtime.addressInUse(port));
      return exit(1);
    }
    server = outcome.server;
    serverPort = port;
    served.taken.add(port);
    post({ type: 'listen', port });
    context.io.stderr(outcome.banner);
  }

  return {
    receive(message) {
      if (served.receive(message) || runtime.receive?.(message)) return;
      switch (message.type) {
        case 'prime':
          mountSnapshot(staging!, message.snapshot);
          return post({ type: 'primed' });
        case 'start':
          start(message).catch((error: unknown) => {
            context.io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            exit(1);
          });
          return;
        case 'fs':
          return applyIncoming(message.ops);
        case 'kill':
          return void stop(message.signal);
        case 'stdin':
          return runtime.stdin?.(message.data);
        case 'socket-open':
        case 'socket-accept':
          // No WebSocket or raw-TCP servers in interpreted apps yet: refuse the connection.
          return post({ type: 'socket-close', connId: message.connId });
        default:
          // Children, IPC, loopback responses: an interpreter process starts none of them.
          return;
      }
    },
  };
}
