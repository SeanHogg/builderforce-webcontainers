/** W10 control 8: the workspace `.npmrc` (registry tokens) is hidden from, and unwritable by, every application view — a service rooted at the workspace included. */
import { describe, expect, it } from 'vitest';
import { FsScopes } from '../src/node/fsScope.js';

describe('FsScopes secrets', () => {
  it('hides and protects <workspace>/.npmrc from every application view', () => {
    const scopes = new FsScopes({ workspaceRoot: '/project' });
    for (const root of ['/project', '/project/api']) {
      const view = scopes.view('app:a', root);
      expect(view.visible('/project/.npmrc')).toBe(false);
      expect(view.judge({ op: 'write', path: '/project/.npmrc', content: 'x' })).toEqual({ allow: false, reason: 'fs.protected_path' });
    }
    expect(scopes.view('app:a', '/project').visible('/project/package.json')).toBe(true); // shared files stay readable
  });
});
