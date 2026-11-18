/**
 * The page side of a training save: `training-artifact` messages from a
 * training process are buffered per process (bounded), and its
 * `training-saved` commits them as ONE save (trainingArtifacts.ts `replace`)
 * under the artifact key the channel (trainingChannel.ts) registered for that
 * process — never anything in the message or the env. The result goes back as
 * `training-saved-ack` (when the page can reach the process), so
 * `bfwc.training.save()` raises on a failed save.
 *
 * - Paths are checked (relative, inside the artifact directory, bounded); a
 *   save over `maxBytes` or `maxFiles` is refused whole.
 * - A save is committed only when received whole: its `training-saved` names
 *   the save being buffered and how many files it sent. An interleaved or
 *   unknown save id, an incomplete save, or an id that does not move forward is
 *   refused — it never commits a partial (or empty) set over the last good one.
 * - A process that exits mid-stream (`exited`) has its buffer dropped.
 * - Saves of one service commit in order, with at most ONE queued behind the
 *   one committing: a newer save replaces the queued one, which is acked as
 *   `superseded`.
 */
import { artifactKeyId, type TrainingArtifactKey, type TrainingArtifactStore } from './trainingArtifacts.js';
import type { TrainingSavedAck, TrainingWorkerMessage } from './trainingProtocol.js';

export interface TrainingSinkOptions {
  store: TrainingArtifactStore;
  /** Bytes one save may hold. Default 512 MB. */
  maxBytes?: number;
  /** Files one save may hold. Default 4096. */
  maxFiles?: number;
}

export const TRAINING_SINK_DEFAULTS = { maxBytes: 512 * 1024 * 1024, maxFiles: 4096 } as const;

/** Who a training message came from: the page-side process and the artifact key the channel registered for it. */
export interface TrainingSender {
  pid: number;
  key: TrainingArtifactKey;
}

export type TrainingReply = (ack: TrainingSavedAck) => void;

interface PendingSave {
  saveId: number;
  files: Map<string, Uint8Array>;
  bytes: number;
  error?: string;
}

interface Commit {
  key: TrainingArtifactKey;
  save: PendingSave;
  reply?: TrainingReply;
}

/** Per service: whether a commit is running, and the ONE save queued behind it. */
interface Lane {
  running: boolean;
  queued?: Commit;
}

export interface TrainingSink {
  /** Take a training message from `sender`; `reply` reaches that process (undefined: it cannot be reached). */
  receive(message: TrainingWorkerMessage, sender: TrainingSender, reply?: TrainingReply): void;
  /** Process `pid` is gone: drop what it was streaming. */
  exited(pid: number): void;
}

/** A relative path with no empty, `.` or `..` segment, bounded. */
export function validArtifactPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.startsWith('/') || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const refused = (saveId: number, error: string): TrainingSavedAck => ({ type: 'training-saved-ack', saveId, ok: false, error });

export function createTrainingSink(options: TrainingSinkOptions): TrainingSink {
  const maxBytes = options.maxBytes ?? TRAINING_SINK_DEFAULTS.maxBytes;
  const maxFiles = options.maxFiles ?? TRAINING_SINK_DEFAULTS.maxFiles;
  /** Per process: the save being streamed. */
  const pending = new Map<number, PendingSave>();
  /** Per process: the last save id it began; ids only move forward. */
  const lastSaveId = new Map<number, number>();
  const lanes = new Map<string, Lane>();

  const answer = (reply: TrainingReply | undefined, ack: TrainingSavedAck) => {
    try {
      reply?.(ack);
    } catch {
      /* the process is gone */
    }
  };

  const commit = async ({ key, save }: Commit): Promise<TrainingSavedAck> => {
    if (save.error) return refused(save.saveId, save.error);
    try {
      await options.store.replace(key, save.files);
      return { type: 'training-saved-ack', saveId: save.saveId, ok: true };
    } catch (error) {
      return refused(save.saveId, error instanceof Error ? error.message : String(error));
    }
  };

  const drain = async (id: string, lane: Lane) => {
    lane.running = true;
    for (let next = lane.queued; next; next = lane.queued) {
      lane.queued = undefined;
      answer(next.reply, await commit(next));
    }
    lane.running = false;
    if (lanes.get(id) === lane) lanes.delete(id);
  };

  const enqueue = (job: Commit) => {
    const id = artifactKeyId(job.key);
    let lane = lanes.get(id);
    if (!lane) lanes.set(id, (lane = { running: false }));
    const superseded = lane.queued;
    lane.queued = job;
    if (superseded) answer(superseded.reply, { ...refused(superseded.save.saveId, 'Superseded by a newer save of this service.'), superseded: true });
    if (!lane.running) void drain(id, lane);
  };

  /** The save `saveId` of `pid`, begun on its first file; undefined when the id does not move forward. */
  const begin = (pid: number, saveId: number): PendingSave | undefined => {
    const current = pending.get(pid);
    if (current?.saveId === saveId) return current;
    if (saveId <= (lastSaveId.get(pid) ?? 0)) return undefined;
    // A newer save abandons the one being streamed (it never sent its `training-saved`).
    const save: PendingSave = { saveId, files: new Map(), bytes: 0 };
    pending.set(pid, save);
    lastSaveId.set(pid, saveId);
    return save;
  };

  return {
    receive(message, { pid, key }, reply) {
      if (!Number.isSafeInteger(message.saveId) || message.saveId <= 0) return;
      if (message.type === 'training-artifact') {
        const save = begin(pid, message.saveId);
        if (!save || save.error) return;
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
      const files = message.files;
      if (!Number.isSafeInteger(files) || files < 0) return answer(reply, refused(message.saveId, 'Malformed save.'));
      const current = pending.get(pid);
      let save: PendingSave;
      if (current?.saveId === message.saveId) {
        pending.delete(pid);
        save = current;
        if (!save.error && save.files.size !== files) save.error = `The save arrived incomplete (${save.files.size} of ${files} files).`;
      } else if (files === 0 && !current && message.saveId > (lastSaveId.get(pid) ?? 0)) {
        // An explicit save of an empty artifact directory: it empties the set.
        lastSaveId.set(pid, message.saveId);
        save = { saveId: message.saveId, files: new Map(), bytes: 0 };
      } else {
        return answer(reply, refused(message.saveId, `Save ${message.saveId} is not the save being received.`));
      }
      enqueue({ key, save, reply });
    },
    exited(pid) {
      pending.delete(pid);
      lastSaveId.delete(pid);
    },
  };
}
