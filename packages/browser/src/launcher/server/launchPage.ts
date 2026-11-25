/**
 * `LocalLauncherOptions.page`: ONE top-level HTML file of the project (`/mockup.html`) the
 * launched application shows at `/` instead of `index.html` — a page launched on its own, with
 * the files beside it (css, js, images) resolved from the project directory. Checked once, when
 * the launcher starts: a page that is not an HTML file directly inside the project fails the
 * launch with a coded {@link LaunchPageError}, instead of booting a blank preview. The code is
 * what a host words in the person's language; the message is English for logs.
 */
import { join } from 'node:path';
import { containedFile } from '../../shared/containedFile.js';

const PAGE_EXTENSION = /\.html?$/i;

export type LaunchPageErrorCode = 'not-relative' | 'not-top-level' | 'not-html' | 'missing' | 'directory' | 'outside';

export class LaunchPageError extends Error {
  constructor(readonly code: LaunchPageErrorCode, readonly page: string, message: string) {
    super(message);
    this.name = 'LaunchPageError';
  }
}

export const isLaunchPageError = (error: unknown): error is LaunchPageError => error instanceof LaunchPageError;

/** The page, validated against `root` (the project's real path); throws a {@link LaunchPageError} otherwise. */
export async function validateLaunchPage(root: string, page: string): Promise<string> {
  if (!page.startsWith('/') || page.includes('\\')) throw new LaunchPageError('not-relative', page, `The page "${page}" must be a project-relative path starting with "/".`);
  const segments = page.split('/').slice(1);
  const name = segments[0];
  if (segments.length !== 1 || name === undefined || name === '' || name === '.' || name === '..') {
    throw new LaunchPageError('not-top-level', page, `The page "${page}" must be a file directly inside the project directory.`);
  }
  if (!PAGE_EXTENSION.test(page)) throw new LaunchPageError('not-html', page, `The page "${page}" is not an HTML file (.html or .htm).`);
  const file = await containedFile(root, join(root, name));
  if (file === 'outside') throw new LaunchPageError('outside', page, `The page "${page}" resolves outside the project directory.`);
  if (file === 'directory') throw new LaunchPageError('directory', page, `The page "${page}" is a directory, not an HTML file.`);
  if (file === null) throw new LaunchPageError('missing', page, `The page "${page}" does not exist in the project directory.`);
  return page;
}
