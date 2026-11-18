/**
 * The messages a training process and the page exchange, beside the process
 * protocol (node/protocol.ts):
 *
 * - the start message's `python.training` (host-set, page side, only for a
 *   process whose page-side identity is a registered `training` service):
 *   whether the page acknowledges saves, and the shared checkpoint flag when
 *   SharedArrayBuffer is available;
 * - page → worker `{type:'checkpoint'}`: the stop asks the program to save and
 *   exit (the shared flag, when present, is raised first);
 * - worker → page `training-artifact` (one file) … then `training-saved` (the
 *   save is complete); page → worker `training-saved-ack` once the page has
 *   committed the whole save (or refused it, with the reason).
 *
 * Plain data and type guards only: imported by both sides.
 */
import type { StartMessage } from '../../node/protocol.js';

export interface TrainingStartOptions {
  /** The page acknowledges each save (`training-saved-ack`): the worker waits for it before the next step (exit included). */
  acks: boolean;
  /** One Int32 cell; non-zero = checkpoint requested. Present only where SharedArrayBuffer is. */
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
}

export interface TrainingSavedAck {
  type: 'training-saved-ack';
  saveId: number;
  ok: boolean;
  error?: string;
}

export type TrainingWorkerMessage = TrainingArtifactMessage | TrainingSavedMessage;
export type TrainingPageMessage = CheckpointMessage | TrainingSavedAck;

const typeOf = (message: unknown) => (typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined);

export const isTrainingWorkerMessage = (message: unknown): message is TrainingWorkerMessage => typeOf(message) === 'training-artifact' || typeOf(message) === 'training-saved';
export const isTrainingPageMessage = (message: unknown): message is TrainingPageMessage => typeOf(message) === 'checkpoint' || typeOf(message) === 'training-saved-ack';

/** The training options the page put in a start message, if any (absent: not a training process). */
export function trainingOptionsOf(message: StartMessage): TrainingStartOptions | undefined {
  return (message.python as { training?: TrainingStartOptions } | undefined)?.training;
}
