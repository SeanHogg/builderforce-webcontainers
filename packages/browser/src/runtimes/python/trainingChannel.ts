/**
 * The page side of training processes, held by the Python process-kind policy
 * (pythonProcessKind.ts):
 *
 * - which process IS a training process: the Python provider `expect`s the
 *   spawn it is about to make for a `training` service (the service's
 *   page-side identity and its stable artifact key, from the spec); the next
 *   process started as that identity consumes the registration — ONE-SHOT —
 *   and is granted `python.training` in its start message. Its children start
 *   as the same identity and get nothing: they have no training control, and
 *   their training messages are refused, so a child cannot overwrite (or wipe)
 *   the service's artifacts. A start without a `processId` is refused;
 * - the checkpoint: a shared Int32 flag per granted process where the page can
 *   share memory with the Worker (`sharedFlags`), and the `checkpoint` message
 *   through the host's `notify` (once `connect`ed); every live training process
 *   of the service — the page-side (applicationId, serviceId), never another
 *   application sharing the artifact key — is asked. The runtime never
 *   requires SharedArrayBuffer;
 * - saves: `training-*` messages from a granted process go to the sink
 *   (trainingSink.ts) with the key registered for it; the acknowledgement goes
 *   back through `notify`;
 * - a process's grant, flag and buffered save are dropped when it exits
 *   (`exited`, from the process host's cleanup).
 */
import { sameService, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { createTrainingArtifactStore, type TrainingArtifactKey, type TrainingArtifactStore } from './trainingArtifacts.js';
import { isTrainingWorkerMessage, type TrainingPageMessage, type TrainingStartOptions } from './trainingProtocol.js';
import { createTrainingSink } from './trainingSink.js';

export interface TrainingOptions {
  /** The host's project id: the first part of every artifact key. */
  projectId: string;
  /** Default: IndexedDB on the page's origin (trainingArtifacts.ts). */
  store?: TrainingArtifactStore;
  /** Bytes one save may hold. Default 512 MB. */
  maxBytes?: number;
  /** Files one save may hold. Default 4096. */
  maxFiles?: number;
  /**
   * Give training processes a shared checkpoint flag (SharedArrayBuffer).
   * Default: only when SharedArrayBuffer exists and the page is cross-origin
   * isolated. The browser host turns it off when processes run behind a relay
   * or on another origin, where memory cannot be shared with the Worker.
   */
  sharedFlags?: boolean;
}

/** Posts a page message to process `pid` (the process host's `notify`); false when it is gone. */
export type NotifyProcess = (pid: number, message: TrainingPageMessage) => boolean;

/** What the Python provider asks of the page side for its training services. */
export interface TrainingServices {
  /**
   * The provider's next spawn as `security` is the service's training process,
   * whose saves are kept under `key`. One-shot: consumed by the first process
   * started as `security`. Returns a release for a spawn that never happened.
   */
  expect(security: SecurityContext, key: Omit<TrainingArtifactKey, 'projectId'>): () => void;
  /** Whether `checkpoint` can reach a process at all (a shared flag, or a connected host). */
  readonly canCheckpoint: boolean;
  /** Whether process `pid` was granted the training control (the provider gives its handle `checkpoint` only then). */
  granted(pid: number): boolean;
  /** Ask every live training process of `pid`'s service (same applicationId and serviceId) to save and exit; how many were asked. */
  checkpoint(pid: number): number;
}

export interface TrainingChannel extends TrainingServices {
  /** The host's way to post to a process. Until connected, saves are not acknowledged and checkpoints use the shared flag only. */
  connect(notify: NotifyProcess): void;
  /** `python.training` for a process starting as `context`, or undefined when it is not an expected training process. */
  startOptions(context: SecurityContext): TrainingStartOptions | undefined;
  /** A message from `context`'s Python process (undefined: not a usable sender); true when it was a training message (taken or refused). */
  receive(message: unknown, context: SecurityContext | undefined): boolean;
  /** Training messages refused (not from a granted process). */
  readonly refused: number;
  /** Process `pid` is gone: drop its grant, flag and buffered save. */
  exited(pid: number): void;
  readonly store: TrainingArtifactStore;
  /** The application was disposed: drop its expected spawns and its processes' grants. */
  forgetApplication(applicationId: string): void;
}

interface Grant {
  security: SecurityContext;
  key: TrainingArtifactKey;
  cell?: Int32Array;
}

const sharedFlagsAvailable = () => typeof SharedArrayBuffer === 'function' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

export function createTrainingChannel(options: TrainingOptions): TrainingChannel {
  const store = options.store ?? createTrainingArtifactStore();
  const sink = createTrainingSink({ store, maxBytes: options.maxBytes, maxFiles: options.maxFiles });
  const shared = options.sharedFlags ?? sharedFlagsAvailable();
  /** Spawns the provider is about to make: identity → key (one-shot). */
  const expected: Array<{ security: SecurityContext; key: TrainingArtifactKey }> = [];
  /** Granted processes by pid. */
  const grants = new Map<number, Grant>();
  let notify: NotifyProcess | undefined;
  let refused = 0;

  const drop = (pid: number) => {
    grants.delete(pid);
    sink.exited(pid);
  };

  return {
    store,
    get refused() {
      return refused;
    },
    connect(next) {
      notify = next;
    },
    expect(security, key) {
      const entry = { security, key: { projectId: options.projectId, ...key } };
      // A newer expectation for the same identity replaces an unconsumed one.
      const stale = expected.findIndex((candidate) => sameService(candidate.security, security));
      if (stale >= 0) expected.splice(stale, 1);
      expected.push(entry);
      return () => {
        const index = expected.indexOf(entry);
        if (index >= 0) expected.splice(index, 1);
      };
    },
    get canCheckpoint() {
      return shared || notify !== undefined;
    },
    granted: (pid) => grants.has(pid),
    checkpoint(pid) {
      const of = grants.get(pid);
      if (!of) return 0;
      let asked = 0;
      for (const [granted, grant] of grants) {
        if (!sameService(grant.security, of.security)) continue;
        if (grant.cell) Atomics.store(grant.cell, 0, 1);
        notify?.(granted, { type: 'checkpoint' });
        asked++;
      }
      return asked;
    },
    startOptions(context) {
      const pid = context?.processId;
      if (pid === undefined) return undefined;
      const index = expected.findIndex((candidate) => sameService(candidate.security, context));
      if (index < 0) return undefined;
      const { key } = expected.splice(index, 1)[0]!;
      const grant: Grant = { security: context, key };
      const result: TrainingStartOptions = { acks: notify !== undefined };
      if (shared) {
        const flag = new SharedArrayBuffer(4);
        grant.cell = new Int32Array(flag);
        result.flag = flag;
      }
      grants.set(pid, grant);
      return result;
    },
    receive(message, context) {
      if (!isTrainingWorkerMessage(message)) return false;
      const pid = context?.processId;
      const grant = pid === undefined ? undefined : grants.get(pid);
      // Only a granted process saves, as the identity it was granted as; anything else (a child, another kind, a forged sender) is refused.
      if (pid === undefined || !grant || !sameService(grant.security, context!)) {
        refused++;
        return true;
      }
      sink.receive(message, { pid, key: grant.key }, notify ? (ack) => void notify?.(pid, ack) : undefined);
      return true;
    },
    exited: drop,
    forgetApplication(applicationId) {
      for (let index = expected.length - 1; index >= 0; index--) if (expected[index]!.security.applicationId === applicationId) expected.splice(index, 1);
      for (const [pid, grant] of [...grants]) if (grant.security.applicationId === applicationId) drop(pid);
    },
  };
}
