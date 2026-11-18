/** A scripted `RuntimeProvider` for orchestrator tests: each started service is a `FakeProcess` the test drives. */
import { ServiceGraphPolicy, type RuntimeProvider, type ServiceHandle, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ApplicationHost } from '../src/app/types.js';

/** The runtime an orchestrator test's application runs on (`startApplicationRuntime`'s required `runtime`): a real port policy, no processes to end. */
export function stubRuntime(): ApplicationHost {
  return { portPolicy: new ServiceGraphPolicy(), killApplication: () => undefined };
}

export class FakeProcess {
  readonly signals: string[] = [];
  /** The identity the runtime started it with (`ServiceStartContext.security`). */
  security?: SecurityContext;
  readonly output: ReadableStream<string>;
  private outputController!: ReadableStreamDefaultController<string>;
  private exitCode: number | undefined;
  private resolveExit!: (code: number) => void;
  private readonly exitPromise = new Promise<number>((resolve) => (this.resolveExit = resolve));
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  constructor(
    readonly service: ServiceSpec,
    readonly env: Record<string, string>,
    /** Ignore SIGTERM (only SIGKILL ends it). */
    readonly stubborn = false,
    private readonly log: string[] = [],
  ) {
    // Like a real process's output: a cancelled stream is not closed (or written) again.
    this.output = new ReadableStream<string>({
      start: (controller) => void (this.outputController = controller),
      cancel: () => void (this.outputOpen = false),
    });
    this.readyPromise.catch(() => undefined);
  }

  private outputOpen = true;

  get exited() {
    return this.exitCode !== undefined;
  }

  write(text: string) {
    if (this.outputOpen) this.outputController.enqueue(text);
  }

  markReady() {
    this.resolveReady();
  }

  exit(code: number) {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.rejectReady(new Error(`Exited with code ${code} before it was ready.`));
    if (this.outputOpen) this.outputController.close();
    this.outputOpen = false;
    this.resolveExit(code);
  }

  handle(): ServiceHandle {
    return {
      output: this.output,
      ready: () => this.readyPromise,
      wait: () => this.exitPromise,
      kill: (signal = 'SIGTERM') => {
        this.signals.push(signal);
        this.log.push(`${signal} ${this.service.id}`);
        if (signal === 'SIGKILL') this.exit(137);
        else if (!this.stubborn) this.exit(143);
      },
      url: () => (this.service.port === undefined ? undefined : `https://preview.test/__port/${this.service.port}/`),
    };
  }
}

export interface FakeProvider {
  provider: RuntimeProvider;
  /** Every process started, in order. */
  started: FakeProcess[];
  /** Processes of one service, oldest first. */
  of(serviceId: string): FakeProcess[];
  /** The newest process of a service. */
  last(serviceId: string): FakeProcess;
  /** Kill signals in the order sent, `SIGTERM api`. */
  kills: string[];
  /** Make the next process of a service ignore SIGTERM. */
  stubborn: Set<string>;
}

/** A promise and its resolver, for gating a step from the test. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * `autoReady`: services whose processes become ready on their own.
 * `startGate`: hold the provider's start of a service until the returned promise settles.
 */
export function fakeProvider(options: { autoReady?: string[]; startGate?: (serviceId: string) => Promise<void> | undefined } = {}): FakeProvider {
  const started: FakeProcess[] = [];
  const kills: string[] = [];
  const stubborn = new Set<string>();
  const of = (serviceId: string) => started.filter((proc) => proc.service.id === serviceId);
  return {
    started,
    kills,
    stubborn,
    of,
    last(serviceId) {
      const procs = of(serviceId);
      if (procs.length === 0) throw new Error(`${serviceId} never started`);
      return procs[procs.length - 1]!;
    },
    provider: {
      id: 'fake',
      accepts: (service) => (service.type === 'application' ? { ok: true } : { ok: false, reason: `fake runs applications, not ${service.type}` }),
      start(service, context) {
        const launch = () => {
          const proc = new FakeProcess(service, context.env, stubborn.has(service.id), kills);
          proc.security = context.security;
          started.push(proc);
          if (options.autoReady?.includes(service.id)) queueMicrotask(() => proc.markReady());
          return proc.handle();
        };
        const gate = options.startGate?.(service.id);
        return gate ? gate.then(launch) : launch();
      },
    },
  };
}

/** Let promise chains and zero-delay timers run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait (up to `timeoutMs`) until `check` holds. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Read entries from a stream until `count` arrived. */
export async function take<T>(stream: ReadableStream<T>, count: number): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  while (items.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    items.push(value);
  }
  await reader.cancel();
  return items;
}
