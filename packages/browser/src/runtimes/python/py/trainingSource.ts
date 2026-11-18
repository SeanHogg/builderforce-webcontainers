/**
 * `bfwc/training.py`: what a training entry point (`python train.py`) uses —
 * metric lines on stdout (they stream through the application's `logs()`),
 * the stop's checkpoint request, and an artifact directory outside the
 * project whose files are kept in project storage (trainingControl.ts).
 * Waits block through JSPI (`run_sync`) where Pyodide has it; without it a
 * request lands whenever the program otherwise yields, and artifacts are
 * persisted when the program exits.
 */
import { TRAINING_ARTIFACT_DIR } from '../trainingArtifacts.js';

export const TRAINING_SOURCE = String.raw`
import os

ARTIFACT_DIR = ${JSON.stringify(TRAINING_ARTIFACT_DIR)}


def _control():
    import _bfwc_training
    return _bfwc_training


def _wait(awaitable):
    try:
        from pyodide.ffi import can_run_sync, run_sync
    except ImportError:
        return None
    if can_run_sync():
        return run_sync(awaitable)
    return None


def artifact_dir(*parts):
    """A directory under the artifact root (created); its files outlive the run, outside the project."""
    path = os.path.join(ARTIFACT_DIR, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def log(step, loss=None, **metrics):
    """One metrics line: step=<n> loss=<x> name=value ..."""
    fields = ["step=%d" % int(step)]
    if loss is not None:
        fields.append("loss=%.6g" % float(loss))
    fields += ["%s=%s" % (name, value) for name, value in metrics.items()]
    print(" ".join(fields), flush=True)


def checkpoint_requested():
    """True once the runtime asked this run to checkpoint (it is stopping): save, then exit."""
    _wait(_control().tick())
    return bool(_control().checkpoint_requested())


def save():
    """Keep the artifact directory in project storage now (it is also kept when the program exits)."""
    _wait(_control().persist())
`;
