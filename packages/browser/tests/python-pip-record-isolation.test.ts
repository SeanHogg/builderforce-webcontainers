/**
 * W10: the `pip install` record is per application, keyed by the page-side
 * SecurityContext — two applications on one runtime neither see nor write each
 * other's installs; the terminal's (workspace) record is a third. First at the
 * policy (what each application's processes start with, where a report lands),
 * then end to end on one runtime: app A's real `pip install` — with an env that
 * claims to be app B — is replayed in A's processes only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { createPythonProcessKind } from '../src/runtimes/python/index.js';
import { FIXTURES, startFakeIndex, type FakeIndex } from './python-index.js';
import { pythonHost, readAll } from './python-helpers.js';

const appA: SecurityContext = { applicationId: 'app-a', serviceId: 'api' };
const appB: SecurityContext = { applicationId: 'app-b', serviceId: 'api' };
const installed = (specs: string[]) => ({ type: 'python-installed', specs, indexUrls: ['https://pypi.example/simple'] });
const installsOf = (kinds: ReturnType<typeof createPythonProcessKind>, context: SecurityContext) => kinds.startOptions('python', context).python?.installs;

describe('pip install record per application (policy)', () => {
  it("app A's install is not replayed in app B, nor in the workspace", () => {
    const kinds = createPythonProcessKind();
    expect(kinds.receive('python', installed(['fixturepkg==1.0']), appA)).toBe(true);
    expect(installsOf(kinds, appA)).toEqual([{ specs: ['fixturepkg==1.0'], indexUrls: ['https://pypi.example/simple'] }]);
    expect(installsOf(kinds, appB)).toEqual([]);
    expect(installsOf(kinds, WORKSPACE_CONTEXT)).toEqual([]);
  });

  it("app B cannot write into app A's record: its report lands in its own", () => {
    const kinds = createPythonProcessKind();
    kinds.receive('python', installed(['realpkg']), appA);
    kinds.receive('python', installed(['evilpkg']), appB);
    expect(kinds.pipRecordFor(appA).read().map((install) => install.specs)).toEqual([['realpkg']]);
    expect(kinds.pipRecordFor(appB).read().map((install) => install.specs)).toEqual([['evilpkg']]);
  });

  it('a report without a usable context is refused', () => {
    const kinds = createPythonProcessKind();
    expect(kinds.receive('python', installed(['orphan']), undefined as unknown as SecurityContext)).toBe(true);
    expect(kinds.receive('python', installed(['orphan']), { applicationId: '', serviceId: 'x' })).toBe(true);
    expect(kinds.rejectedReports).toBe(2);
    expect(kinds.pipRecord.read()).toEqual([]);
    expect(kinds.startOptions('python', undefined as unknown as SecurityContext).python?.installs).toEqual([]);
  });

  it('a disposed application loses its record; the workspace keeps its own', () => {
    const kinds = createPythonProcessKind();
    kinds.receive('python', installed(['a']), appA);
    kinds.receive('python', installed(['w']), WORKSPACE_CONTEXT);
    kinds.forgetApplication('app-a');
    kinds.forgetApplication(WORKSPACE_CONTEXT.applicationId);
    expect(installsOf(kinds, appA)).toEqual([]);
    expect(kinds.pipRecord.read().map((install) => install.specs)).toEqual([['w']]);
  });
});

describe('pip install record per application (one runtime, real pip)', () => {
  let index: FakeIndex;
  beforeAll(async () => {
    index = await startFakeIndex(FIXTURES);
  });
  afterAll(() => index.close());

  it("an env claiming app B does not put app A's install in B's record", { timeout: 240_000 }, async () => {
    const { python, kinds } = pythonHost();
    const spoof = { PIP_INDEX_URL: index.url, BUILDERFORCE_PROJECT_ID: 'app-b', BUILDERFORCE_SERVICE: 'api', BUILDERFORCE_APPLICATION_ID: 'app-b' };
    const pip = python.run('pip', ['install', '--no-cache-dir', 'fixturepkg==1.0.0'], { identity: appA, env: spoof });
    expect(await readAll(pip.combinedOutput)).toContain('Successfully installed fixturepkg');
    expect(await pip.wait()).toBe(0);
    expect(kinds.pipRecordFor(appA).read()).toEqual([{ specs: ['fixturepkg==1.0.0'], indexUrls: [index.url] }]);
    expect(installsOf(kinds, appB)).toEqual([]);
    expect(kinds.pipRecord.read()).toEqual([]);

    const check = 'import importlib.util; print("has fixturepkg:", importlib.util.find_spec("fixturepkg") is not None)';
    const inA = python.run('python', ['-c', check], { identity: appA });
    expect(await readAll(inA.combinedOutput)).toContain('has fixturepkg: True');
    const inB = python.run('python', ['-c', check], { identity: appB, env: spoof });
    expect(await readAll(inB.combinedOutput)).toContain('has fixturepkg: False');
    python.dispose();
  });
});
