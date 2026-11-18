/**
 * The worker side of a training program: the `_bfwc_training` JS module that
 * `bfwc.training` (py/trainingSource.ts) drives — installed ONLY when the
 * page's start message carries `python.training` (trainingProtocol.ts).
 *
 * - Checkpoint: the shared flag when the page sent one (read synchronously);
 *   otherwise the `checkpoint` message, which lands while the program is
 *   suspended — `should_yield()` lets it suspend at most every {@link YIELD_MS}.
 * - Saves: every regular file under the artifact directory (symlinks skipped,
 *   walked with lstat, one file at a time) is posted to the page, then
 *   `training-saved` with the file count; with acknowledgements the save
 *   resolves with the page's verdict (`confirmed`), without them it resolves
 *   unconfirmed. A save the page dropped for a newer one is `superseded`, not
 *   failed.
 * - The exit save is skipped when the artifact directory is missing or empty
 *   (a run that crashed before writing anything never wipes the last good
 *   set); its failure is written to stderr and the program's own exit code is
 *   kept.
 */
import type { WorkerToHost } from '../../node/protocol.js';
import type { PyodideLike } from './pyodideLoader.js';
import { TRAINING_ARTIFACT_DIR } from './trainingArtifactDir.js';
import { isTrainingPageMessage, type TrainingStartOptions } from './trainingProtocol.js';

export const TRAINING_JS_MODULE = '_bfwc_training';
/** The longest a program goes between suspensions when it polls for a checkpoint without a shared flag. */
export const YIELD_MS = 50;
/** How long a save waits for the page's acknowledgement. */
export const ACK_TIMEOUT_MS = 120_000;

export interface SaveResult {
  ok: boolean;
  error?: string;
  /** The page acknowledged committing this save. False when the page does not acknowledge saves. */
  confirmed: boolean;
  /** A newer save of the service replaced this one before it was committed. */
  superseded?: boolean;
}

export interface TrainingControl {
  /** A page message for the training control; true when taken. */
  receive(message: unknown): boolean;
  /** Register `_bfwc_training` in `py` (a training process only). */
  install(py: PyodideLike, options: TrainingStartOptions): void;
  /** The exit save: skipped when the artifact directory is missing or empty; failures go to `stderr`. A no-op when not installed. */
  saveAtExit(stderr: (text: string) => void): Promise<void>;
}

type Post = (message: WorkerToHost, transfer?: Transferable[]) => void;

/** Regular files under `dir`, depth first, one at a time; symlinks are never followed or sent. */
function* artifactFiles(FS: PyodideLike['FS'], dir: string, relative = ''): Generator<[string, string]> {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const rel = relative ? `${relative}/${name}` : name;
    const { mode } = FS.lstat(full);
    if (FS.isLink(mode)) continue;
    if (FS.isDir(mode)) yield* artifactFiles(FS, full, rel);
    else if (FS.isFile(mode)) yield [rel, full];
  }
}

/** The artifact directory's regular files; none when it is missing. */
const listArtifacts = (FS: PyodideLike['FS']): Array<[string, string]> => (FS.analyzePath(TRAINING_ARTIFACT_DIR).exists ? [...artifactFiles(FS, TRAINING_ARTIFACT_DIR)] : []);

export function createTrainingControl(post: Post): TrainingControl {
  let requested = false;
  let installed: { py: PyodideLike; options: TrainingStartOptions; cell?: Int32Array } | undefined;
  let saveId = 0;
  let lastYield = 0;
  const acks = new Map<number, (ack: SaveResult) => void>();

  async function save(atExit = false): Promise<SaveResult> {
    if (!installed) return { ok: false, error: 'Not a training process.', confirmed: false };
    const { py, options } = installed;
    const id = ++saveId;
    let files: Array<[string, string]>;
    try {
      files = listArtifacts(py.FS);
      if (atExit && files.length === 0) return { ok: true, confirmed: false };
      for (const [path, full] of files) {
        const bytes = py.FS.readFile(full);
        post({ type: 'training-artifact', saveId: id, path, bytes }, [bytes.buffer as ArrayBuffer]);
      }
    } catch (error) {
      return { ok: false, error: `Could not read the artifacts: ${error instanceof Error ? error.message : String(error)}`, confirmed: false };
    }
    const acked = options.acks
      ? new Promise<SaveResult>((resolve) => {
          acks.set(id, resolve);
          setTimeout(() => acks.get(id) === resolve && (acks.delete(id), resolve({ ok: false, error: 'The page did not acknowledge the save.', confirmed: false })), ACK_TIMEOUT_MS);
        })
      : undefined;
    post({ type: 'training-saved', saveId: id, files: files.length });
    return acked ?? { ok: true, confirmed: false };
  }

  return {
    receive(message) {
      if (!isTrainingPageMessage(message)) return false;
      if (message.type === 'checkpoint') {
        requested = true;
        return true;
      }
      acks.get(message.saveId)?.(message.superseded ? { ok: true, confirmed: false, superseded: true } : { ok: message.ok, error: message.error, confirmed: message.ok });
      acks.delete(message.saveId);
      return true;
    },
    install(py, options) {
      installed = { py, options, cell: options.flag ? new Int32Array(options.flag) : undefined };
      const cell = installed.cell;
      py.registerJsModule(TRAINING_JS_MODULE, {
        checkpoint_requested: () => requested || (cell !== undefined && Atomics.load(cell, 0) !== 0),
        /** Only without a shared flag, and at most every YIELD_MS: a suspension lets a `checkpoint` message land. */
        should_yield: () => {
          if (cell || requested) return false;
          const now = Date.now();
          if (now - lastYield < YIELD_MS) return false;
          lastYield = now;
          return true;
        },
        tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
        /** Resolves with `{ error, confirmed }`: `error` '' unless the save failed (Python raises it); `confirmed` once the page committed it. */
        save: () => save().then((result) => ({ error: result.ok ? '' : (result.error ?? 'The save failed.'), confirmed: result.confirmed })),
      });
    },
    async saveAtExit(stderr) {
      if (!installed) return;
      const result = await save(true);
      if (!result.ok) stderr(`bfwc.training: the artifacts were not saved: ${result.error ?? 'unknown error'}\n`);
    },
  };
}
