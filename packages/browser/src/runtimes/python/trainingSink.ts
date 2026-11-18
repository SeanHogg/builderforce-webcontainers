/**
 * The page side of a training save: `training-artifact` messages from a
 * process are buffered per process (bounded), and its `training-saved` commits
 * them as ONE save (trainingArtifacts.ts `replace`), keyed by the host's
 * project id and the sender's page-side identity — the `context` the process
 * host resolves from the Worker, never anything in the message or the env.
 * The result goes back as `training-saved-ack` (when the page can reach the
 * process), so `bfwc.training.save()` raises on a failed save.
 *
 * Paths are checked (relative, inside the artifact directory, bounded); a save
 * over `maxBytes` or `maxFiles` is refused whole.
 */
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { TrainingArtifactStore } from './trainingArtifacts.js';
import type { TrainingSavedAck, TrainingWorkerMessage } from './trainingProtocol.js';

export interface TrainingSinkOptions {
  /** The host's project id: the first part of every artifact key. */
  projectId: string;
  store: TrainingArtifactStore;
  /** Bytes one save may hold. Default 512 MB. */
  maxBytes?: number;
  /** Files one save may hold. Default 4096. */
  maxFiles?: number;
}

export const TRAINING_SINK_DEFAULTS = { maxBytes: 512 * 1024 * 1024, maxFiles: 4096 } as const;

interface PendingSave {
  saveId: number;
  files: Map<string, Uint8Array>;
  bytes: number;
  error?: string;
}

export interface TrainingSink {
  /** Take a training message from `context`'s process; `reply` reaches that process (undefined: it cannot be reached). */
  receive(message: TrainingWorkerMessage, context: SecurityContext, reply?: (ack: TrainingSavedAck) => void): void;
  /** Drop what is buffered for `applicationId`'s processes. */
  forgetApplication(applicationId: string): void;
}

/** A relative path with no empty, `.` or `..` segment, bounded. */
export function validArtifactPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.startsWith('/') || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function createTrainingSink(options: TrainingSinkOptions): TrainingSink {
  const maxBytes = options.maxBytes ?? TRAINING_SINK_DEFAULTS.maxBytes;
  const maxFiles = options.maxFiles ?? TRAINING_SINK_DEFAULTS.maxFiles;
  /** Per process (`processId`): the save being streamed. */
  const pending = new Map<number, PendingSave & { applicationId: string }>();
  /** Saves of one service commit in order. */
  const commits = new Map<string, Promise<void>>();

  const pendingFor = (context: SecurityContext, saveId: number) => {
    const pid = context.processId ?? -1;
    let save = pending.get(pid);
    if (!save || save.saveId !== saveId) pending.set(pid, (save = { saveId, files: new Map(), bytes: 0, applicationId: context.applicationId }));
    return save;
  };

  return {
    receive(message, context, reply) {
      if (!Number.isSafeInteger(message.saveId)) return;
      const save = pendingFor(context, message.saveId);
      if (message.type === 'training-artifact') {
        if (save.error) return;
        if (!validArtifactPath(message.path) || !(message.bytes instanceof Uint8Array)) save.error = `Refused artifact path ${JSON.stringify(String(message.path)).slice(0, 80)}.`;
        else {
          save.bytes += message.bytes.byteLength - (save.files.get(message.path)?.byteLength ?? 0);
          save.files.set(message.path, message.bytes);
          if (save.bytes > maxBytes) save.error = `The save is over ${maxBytes} bytes.`;
          else if (save.files.size > maxFiles) save.error = `The save is over ${maxFiles} files.`;
        }
        if (save.error) save.files.clear();
        return;
      }
      pending.delete(context.processId ?? -1);
      const key = { projectId: options.projectId, applicationId: context.applicationId, serviceId: context.serviceId };
      const id = JSON.stringify([key.applicationId, key.serviceId]);
      const commit = (commits.get(id) ?? Promise.resolve()).then(async (): Promise<TrainingSavedAck> => {
        if (save.error) return { type: 'training-saved-ack', saveId: save.saveId, ok: false, error: save.error };
        try {
          await options.store.replace(key, save.files);
          return { type: 'training-saved-ack', saveId: save.saveId, ok: true };
        } catch (error) {
          return { type: 'training-saved-ack', saveId: save.saveId, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
      const done = commit.then((ack) => reply?.(ack));
      commits.set(id, done);
      void done.finally(() => commits.get(id) === done && commits.delete(id));
    },
    forgetApplication(applicationId) {
      for (const [pid, save] of pending) if (save.applicationId === applicationId) pending.delete(pid);
    },
  };
}
