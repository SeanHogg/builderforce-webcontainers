/**
 * The worker side of a training program: the `_bfwc_training` JS module that
 * `bfwc.training` (py/trainingSource.ts) drives. It holds the checkpoint flag
 * (raised when the page's {@link CHECKPOINT_REQUEST} line arrives on stdin,
 * which never reaches the program's own input) and persists what the program
 * wrote under the artifact directory to project storage outside the VFS
 * (trainingArtifacts.ts) — on `bfwc.training.save()` and when the program exits.
 */
import { CHECKPOINT_REQUEST } from '../../app/checkpointRequest.js';
import type { PyodideLike } from './pyodideLoader.js';
import { artifactFiles, type TrainingArtifactStore } from './trainingArtifacts.js';

export const TRAINING_JS_MODULE = '_bfwc_training';

export interface TrainingControl {
  /** Stdin lines minus checkpoint requests (each one raises the flag). */
  take(lines: string[]): string[];
  /** Register `_bfwc_training` in `py`, persisting for the service named by `env`. */
  install(py: PyodideLike, env: Readonly<Record<string, string>>): void;
  /** Persist the artifact directory now (no-op before `install` or without a project id). */
  persist(): Promise<void>;
}

export function createTrainingControl(store: () => TrainingArtifactStore): TrainingControl {
  let requested = false;
  let persist: () => Promise<void> = async () => undefined;
  return {
    take(lines) {
      return lines.filter((line) => {
        if (line !== CHECKPOINT_REQUEST) return true;
        requested = true;
        return false;
      });
    },
    install(py, env) {
      const projectId = env.BUILDERFORCE_PROJECT_ID;
      const serviceId = env.BUILDERFORCE_SERVICE ?? 'python';
      persist = async () => {
        if (!projectId) return;
        const artifacts = store();
        for (const [path, data] of artifactFiles(py.FS)) await artifacts.write(projectId, serviceId, path, data);
      };
      py.registerJsModule(TRAINING_JS_MODULE, {
        checkpoint_requested: () => requested,
        /** A macrotask: lets pending worker messages (a checkpoint request) land while the program is suspended. */
        tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
        persist: () => persist(),
      });
    },
    persist: () => persist(),
  };
}
