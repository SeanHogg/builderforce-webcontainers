/**
 * `bfwc/training.py`: what a training entry point (`python train.py`) uses —
 * metric lines on stdout (they stream through the application's `logs()`),
 * the stop's checkpoint request, and an artifact directory outside the
 * project whose files the page keeps in project storage (trainingControl.ts).
 * The control exists only in a `training` service's process. Without a shared
 * flag, `checkpoint_requested()` suspends (JSPI `run_sync`) at most every few
 * tens of milliseconds so the page's request can land; without JSPI it lands
 * when the program otherwise yields. Artifacts are also saved when the program exits.
 */
import { TRAINING_ARTIFACT_DIR } from '../trainingArtifactDir.js';

export const TRAINING_SOURCE = String.raw`
import os

ARTIFACT_DIR = ${JSON.stringify(TRAINING_ARTIFACT_DIR)}


def _control():
    try:
        import _bfwc_training
    except ImportError:
        raise RuntimeError("bfwc.training: this process is not a training service") from None
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
    path = os.path.normpath(os.path.join(ARTIFACT_DIR, *parts))
    if path != ARTIFACT_DIR and not path.startswith(ARTIFACT_DIR + "/"):
        raise ValueError("bfwc.training.artifact_dir: %r is outside %s" % (os.path.join(*parts) if parts else "", ARTIFACT_DIR))
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
    control = _control()
    if control.should_yield():
        _wait(control.tick())
    return bool(control.checkpoint_requested())


def save():
    """Replace the kept artifacts with the artifact directory now (also done at exit). Raises when the page refused or failed the save."""
    error = _wait(_control().save())
    if error:
        raise RuntimeError("bfwc.training.save: " + str(error))
`;
