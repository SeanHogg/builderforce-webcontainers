/**
 * W10: the `pip install` record is per application, keyed by the page-side
 * SecurityContext — two applications on one runtime neither see nor write each
 * other's installs; the terminal's (workspace) record is a third. Tested at the
 * Python process-kind policy: what a process of each application starts with
 * (`startOptions` → the installs it replays, i.e. what its `pip list` shows)
 * and where its `python-installed` report lands (`receive`).
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { createPythonProcessKind } from '../src/runtimes/python/index.js';

const appA: SecurityContext = { applicationId: 'app-a', serviceId: 'api' };
const appB: SecurityContext = { applicationId: 'app-b', serviceId: 'api' };
const installed = (specs: string[]) => ({ type: 'python-installed', specs, indexUrls: ['https://pypi.example/simple'] });
const installsOf = (kinds: ReturnType<typeof createPythonProcessKind>, context?: SecurityContext) => kinds.startOptions('python', context).python?.installs;

describe('pip install record per application', () => {
  it("app A's install is not replayed in app B (B's pip list does not show it), nor in the workspace", () => {
    const kinds = createPythonProcessKind();
    expect(kinds.receive('python', installed(['fixturepkg==1.0']), appA)).toBe(true);
    expect(installsOf(kinds, appA)).toEqual([{ specs: ['fixturepkg==1.0'], indexUrls: ['https://pypi.example/simple'] }]);
    expect(installsOf(kinds, appB)).toEqual([]);
    expect(installsOf(kinds, WORKSPACE_CONTEXT)).toEqual([]);
    expect(kinds.pipRecord.read()).toEqual([]);
  });

  it("app B cannot write into app A's record: its report lands in its own", () => {
    const kinds = createPythonProcessKind();
    kinds.receive('python', installed(['realpkg']), appA);
    kinds.receive('python', installed(['evilpkg']), appB);
    expect(kinds.pipRecordFor(appA).read().map((install) => install.specs)).toEqual([['realpkg']]);
    expect(kinds.pipRecordFor(appB).read().map((install) => install.specs)).toEqual([['evilpkg']]);
  });

  it('a process env naming another application changes nothing: only the context keys the record', () => {
    const kinds = createPythonProcessKind();
    kinds.receive('python', { ...installed(['spoof']), BUILDERFORCE_PROJECT_ID: 'app-a', applicationId: 'app-a' }, appB);
    expect(kinds.pipRecordFor(appA).read()).toEqual([]);
  });

  it('without a context it is the workspace record (terminal, installs)', () => {
    const kinds = createPythonProcessKind();
    kinds.receive('python', installed(['termpkg']));
    expect(kinds.pipRecordFor(WORKSPACE_CONTEXT).read().map((install) => install.specs)).toEqual([['termpkg']]);
    expect(installsOf(kinds)).toEqual(kinds.pipRecord.read());
    expect(installsOf(kinds, appA)).toEqual([]);
  });
});
