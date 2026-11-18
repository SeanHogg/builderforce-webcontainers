/**
 * The runtime's own Python modules, written into Pyodide outside the project
 * mount and put first on `sys.path`: the `bfwc` package (run, serve, threads,
 * vsocket) and the `uvicorn`/`gunicorn` stand-ins (uvicornSource.ts).
 */
import type { PyodideLike } from '../pyodideLoader.js';
import { RUN_SOURCE } from './runSource.js';
import { SERVE_SOURCE } from './serveSource.js';
import { SOCKET_SOURCE } from './socketSource.js';
import { THREADS_SOURCE } from './threadsSource.js';
import { GUNICORN_SOURCE, UVICORN_SOURCE, UVICORN_WORKERS_SOURCE } from './uvicornSource.js';

export const BFWC_PACKAGE_ROOT = '/opt/bfwc';

const FILES: Readonly<Record<string, string>> = {
  'bfwc/__init__.py': '',
  'bfwc/run.py': RUN_SOURCE,
  'bfwc/serve.py': SERVE_SOURCE,
  'bfwc/threads.py': THREADS_SOURCE,
  'bfwc/vsocket.py': SOCKET_SOURCE,
  'uvicorn/__init__.py': UVICORN_SOURCE,
  'uvicorn/workers.py': UVICORN_WORKERS_SOURCE,
  'gunicorn/__init__.py': GUNICORN_SOURCE,
};

export function installBfwcPackage(pyodide: PyodideLike): void {
  for (const [path, source] of Object.entries(FILES)) {
    const target = `${BFWC_PACKAGE_ROOT}/${path}`;
    pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    pyodide.FS.writeFile(target, source);
  }
  pyodide.runPython(`import sys\nif ${JSON.stringify(BFWC_PACKAGE_ROOT)} not in sys.path: sys.path.insert(0, ${JSON.stringify(BFWC_PACKAGE_ROOT)})`);
}
