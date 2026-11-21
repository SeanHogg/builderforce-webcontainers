import { describe, expect, it } from 'vitest';
import { validateWorkspacePath } from './paths.js';

describe('validateWorkspacePath', () => {
  it('accepts a project-relative path', () => {
    expect(validateWorkspacePath('.builderforce/logs')).toBeNull();
    expect(validateWorkspacePath('docs/notes')).toBeNull();
  });

  it('rejects empty, absolute, and parent segments', () => {
    expect(validateWorkspacePath('')).toBe('path-empty');
    expect(validateWorkspacePath('   ')).toBe('path-empty');
    expect(validateWorkspacePath('/tmp/x')).toBe('path-absolute');
    expect(validateWorkspacePath('\\tmp\\x')).toBe('path-absolute');
    expect(validateWorkspacePath('C:\\x')).toBe('path-absolute');
    expect(validateWorkspacePath('../x')).toBe('path-parent');
    expect(validateWorkspacePath('logs/../../x')).toBe('path-parent');
  });
});
