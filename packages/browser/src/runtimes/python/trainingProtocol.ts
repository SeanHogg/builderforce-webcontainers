/**
 * The messages a training process and the page exchange, part of the process
 * protocol (node/protocol.ts carries them in `PythonStartOptions.training`,
 * `HostToWorker` and `WorkerToHost`):
 *
 * - the start message's `python.training` (host-set, page side, only for the
 *   ROOT process the Python provider spawned for a `training` service — its
 *   children get none): whether the page acknowledges saves, and the shared
 *   checkpoint flag when the page could share memory with the Worker;
 * - page → worker `{type:'checkpoint'}`: the stop asks the program to save and
 *   exit (the shared flag, when present, is raised first);
 * - worker → page `training-artifact` (one file) … then `training-saved` (the
 *   save is complete, with how many files it sent); page → worker
 *   `training-saved-ack` once the page has committed the whole save, refused
 *   it (with the reason), or dropped it for a newer save of the same service
 *   (`superseded`).
 *
 * Plain data and type guards only: imported by both sides.
 */

export interface TrainingStartOptions {
  /** The page acknowledges each save (`training-saved-ack`): the worker waits for it before the next step (exit included). */
  acks: boolean;
  /** One Int32 cell; non-zero = checkpoint requested. Present only where the page can share memory with the Worker. */
  flag?: SharedArrayBuffer;
}

export interface CheckpointMessage {
  type: 'checkpoint';
}

export interface TrainingArtifactMessage {
  type: 'training-artifact';
  saveId: number;
  /** Relative to the artifact directory. */
  path: string;
  bytes: Uint8Array;
}

export interface TrainingSavedMessage {
  type: 'training-saved';
  saveId: number;
  /** How many `training-artifact` messages this save sent: the page commits only a save it received whole. */
  files: number;
}

export interface TrainingSavedAck {
  type: 'training-saved-ack';
  saveId: number;
  ok: boolean;
  error?: string;
  /** Not committed because a newer save of the same service replaced it in the queue (not an error of this save). */
  superseded?: boolean;
}

export type TrainingWorkerMessage = TrainingArtifactMessage | TrainingSavedMessage;
export type TrainingPageMessage = CheckpointMessage | TrainingSavedAck;

const typeOf = (message: unknown) => (typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined);

export const isTrainingWorkerMessage = (message: unknown): message is TrainingWorkerMessage => typeOf(message) === 'training-artifact' || typeOf(message) === 'training-saved';
export const isTrainingPageMessage = (message: unknown): message is TrainingPageMessage => typeOf(message) === 'checkpoint' || typeOf(message) === 'training-saved-ack';
