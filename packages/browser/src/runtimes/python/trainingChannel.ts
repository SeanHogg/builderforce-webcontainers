/**
 * The page side of training processes, held by the Python process-kind policy
 * (pythonProcessKind.ts):
 *
 * - which page-side identities are `training` services (the Python provider
 *   registers them from the spec before it spawns): only their processes get
 *   `python.training` in the start message — the worker installs the training
 *   control for nothing else;
 * - the checkpoint: a shared Int32 flag per process where SharedArrayBuffer is
 *   available (read synchronously by the program), and the `checkpoint`
 *   message through the host's `notify` (once `connect`ed); the runtime never
 *   requires SharedArrayBuffer;
 * - saves: `training-*` messages go to the sink (trainingSink.ts) with the
 *   sender's page-side identity; its acknowledgement goes back through `notify`.
 */
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { createTrainingArtifactStore, type TrainingArtifactStore } from './trainingArtifacts.js';
import { isTrainingWorkerMessage, type TrainingPageMessage, type TrainingStartOptions } from './trainingProtocol.js';
import { createTrainingSink } from './trainingSink.js';

export interface TrainingOptions {
  /** The host's project id: artifacts are keyed by it and the process's page-side identity. */
  projectId: string;
  /** Default: IndexedDB on the page's origin (trainingArtifacts.ts). */
  store?: TrainingArtifactStore;
  /** Bytes one save may hold. Default 512 MB. */
  maxBytes?: number;
  /** Use a shared flag where SharedArrayBuffer exists. Default: when it exists and the page is not known to lack cross-origin isolation. */
  sharedFlags?: boolean;
}

/** Posts a page message to process `pid` (the process host's `notify`); false when it is gone. */
export type NotifyProcess = (pid: number, message: TrainingPageMessage) => boolean;

/** What the Python provider asks of the page side for its training services. */
export interface TrainingServices {
  /** `security` is a training service: its processes start with the training control. */
  register(security: SecurityContext): void;
  /** Whether `checkpoint(pid)` can reach a process at all (a shared flag, or a connected host). */
  readonly canCheckpoint: boolean;
  /** Ask process `pid` to save and exit. */
  checkpoint(pid: number): void;
}

export interface TrainingChannel extends TrainingServices {
  /** The host's way to post to a process. Until connected, saves are not acknowledged and checkpoints use the shared flag only. */
  connect(notify: NotifyProcess): void;
  /** `python.training` for a process of `context`, or undefined when it is not a training service. */
  startOptions(context: SecurityContext): TrainingStartOptions | undefined;
  /** A training message from `context`'s process; true when taken. */
  receive(message: unknown, context: SecurityContext): boolean;
  readonly store: TrainingArtifactStore;
  forgetApplication(applicationId: string): void;
}

const serviceKey = (context: SecurityContext) => JSON.stringify([context.applicationId, context.serviceId]);

const sharedFlagsAvailable = () => typeof SharedArrayBuffer === 'function' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;

export function createTrainingChannel(options: TrainingOptions): TrainingChannel {
  const store = options.store ?? createTrainingArtifactStore();
  const sink = createTrainingSink({ projectId: options.projectId, store, maxBytes: options.maxBytes });
  const shared = options.sharedFlags ?? sharedFlagsAvailable();
  const training = new Map<string, string>(); // service key → applicationId
  const flags = new Map<number, { applicationId: string; cell: Int32Array }>();
  let notify: NotifyProcess | undefined;

  return {
    store,
    connect(next) {
      notify = next;
    },
    register(security) {
      training.set(serviceKey(security), security.applicationId);
    },
    get canCheckpoint() {
      return shared || notify !== undefined;
    },
    checkpoint(pid) {
      const flag = flags.get(pid);
      if (flag) Atomics.store(flag.cell, 0, 1);
      notify?.(pid, { type: 'checkpoint' });
    },
    startOptions(context) {
      if (!training.has(serviceKey(context))) return undefined;
      const result: TrainingStartOptions = { acks: notify !== undefined };
      if (shared && context.processId !== undefined) {
        const flag = new SharedArrayBuffer(4);
        flags.set(context.processId, { applicationId: context.applicationId, cell: new Int32Array(flag) });
        result.flag = flag;
      }
      return result;
    },
    receive(message, context) {
      if (!isTrainingWorkerMessage(message)) return false;
      // Only a registered training service's processes save; anything else is refused silently.
      if (!training.has(serviceKey(context))) return true;
      const pid = context.processId;
      sink.receive(message, context, notify && pid !== undefined ? (ack) => void notify?.(pid, ack) : undefined);
      return true;
    },
    forgetApplication(applicationId) {
      for (const [key, owner] of training) if (owner === applicationId) training.delete(key);
      for (const [pid, flag] of flags) if (flag.applicationId === applicationId) flags.delete(pid);
      sink.forgetApplication(applicationId);
    },
  };
}
