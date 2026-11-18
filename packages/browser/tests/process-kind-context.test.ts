/**
 * W10: a process kind's reports are keyed by the page-side identity of the
 * Worker they arrived on, through the whole policy chain (Rust → .NET → PHP →
 * Python). App A's `pip install` lands only in A's record — never B's, never
 * the workspace's — and only a workspace process may set the shared PHP platform.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import { createDotnetProcessKind } from '../src/runtimes/dotnet/index.js';
import { createPhpProcessKind } from '../src/runtimes/php/index.js';
import { createPythonProcessKind } from '../src/runtimes/python/index.js';
import { createRustProcessKind } from '../src/runtimes/rust/index.js';

const A: SecurityContext = { applicationId: 'app-a', serviceId: 'api' };
const B: SecurityContext = { applicationId: 'app-b', serviceId: 'api' };
const installed = (specs: string[]) => ({ type: 'python-installed', specs, indexUrls: ['https://pypi.example/simple'] });
const platform = { type: 'php-platform', phpVersion: '8.3.36', extensions: ['intl'] };

function chainedHost() {
  const fs = new VirtualFileSystem();
  fs.writeTree({ 'a/app.py': '', 'b/app.py': '', 'a/index.php': '' });
  const python = createPythonProcessKind();
  const php = createPhpProcessKind({}, python);
  const workers: WorkerLike[] = [];
  const processes = new ProcessHost({
    fs,
    createWorker: () => {
      const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined };
      workers.push(worker);
      return worker;
    },
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    warmWorker: false,
    kinds: createRustProcessKind(createDotnetProcessKind({}, php)),
  });
  const send = (index: number, message: unknown) => workers[index]!.onmessage?.({ data: message });
  return { processes, python, php, send };
}

describe('process-kind reports keyed by the page-side identity', () => {
  it("app A's pip report never appears in app B's record or the workspace's, whatever the message claims", () => {
    const { processes, python, send } = chainedHost();
    processes.spawnChild('python', ['app.py'], { identity: A, cwd: '/a' });
    send(0, { ...installed(['fixturepkg==1.0']), applicationId: 'app-b', identity: B });
    expect(python.pipRecordFor(A).read().map((install) => install.specs)).toEqual([['fixturepkg==1.0']]);
    expect(python.pipRecordFor(B).read()).toEqual([]);
    expect(python.pipRecordFor(WORKSPACE_CONTEXT).read()).toEqual([]);
    // B's next Python process replays nothing of A's.
    processes.spawnChild('python', ['app.py'], { identity: B, cwd: '/b' });
    expect(python.startOptions('python', B).python?.installs).toEqual([]);
  });

  it("an application's php-platform report is ignored; a workspace PHP process's is kept", () => {
    const { processes, php, send } = chainedHost();
    processes.spawnChild('php', ['index.php'], { identity: A, cwd: '/a' });
    send(0, platform);
    expect(php.platform.current()).toBeUndefined();
    processes.spawnChild('php', ['-v']);
    send(1, platform);
    expect(php.platform.current()?.phpVersion).toBe('8.3.36');
  });
});
