import { extname } from '../paths.js';

/**
 * Which files are stylesheets, in which language — the one place that says so,
 * for the dev server, the build and component `<style lang>` blocks alike.
 */
export type StyleLanguage = 'css' | 'scss' | 'sass' | 'less';

const BY_EXTENSION: Record<string, StyleLanguage> = { '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less' };

/** The language of a stylesheet path, or undefined when it is not one. */
export function styleLanguageOf(path: string): StyleLanguage | undefined {
  return BY_EXTENSION[extname(path).toLowerCase()];
}

export function isStylesheet(path: string): boolean {
  return styleLanguageOf(path) !== undefined;
}

/** `card.module.css`, `card.module.scss`: class names are scoped to the file. */
export function isCssModule(path: string): boolean {
  return /\.module\.(css|scss|sass|less)$/i.test(path);
}

/** A `<style lang="…">` value as a language; `postcss` and absent mean plain CSS. */
export function styleLanguageOfLang(lang: string | undefined): StyleLanguage | undefined {
  if (!lang || lang === 'css' || lang === 'postcss') return 'css';
  return lang === 'scss' || lang === 'sass' || lang === 'less' ? lang : undefined;
}
