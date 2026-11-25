/**
 * The code-scanning PORT. The runtime depends on this interface, never on a scanner: the embedding
 * page injects an implementation (Builderforce binds it to `@builderforce/code-shield` in a Web Worker),
 * so this package imports nothing from the product and stays separately publishable.
 *
 * A scan that cannot finish is reported `complete: false`; it is never reported as clean.
 */
export type CodeScanOrigin = 'install' | 'write' | 'spawn';

export interface CodeScanSubject {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly packageName?: string;
  readonly packageVersion?: string;
}

export interface CodeScanVerdict {
  readonly path: string;
  readonly action: 'allow' | 'log' | 'review' | 'quarantine' | 'block';
  readonly complete: boolean;
  /** 0..100 risk score. */
  readonly score: number;
  /** Rule ids only: never the matched text. */
  readonly ruleIds: readonly string[];
}

export interface CodeScanner {
  scan(origin: CodeScanOrigin, subjects: readonly CodeScanSubject[], signal?: AbortSignal): Promise<readonly CodeScanVerdict[]>;
}

/** What the embedder wants done with a scan that could not finish. */
export type ScanIncompletePolicy = 'refuse' | 'warn';

/** A verdict the runtime must act on: the code does not run, install or stay on disk. */
export const refuses = (verdict: CodeScanVerdict): boolean => verdict.action === 'block' || verdict.action === 'quarantine';

/** Extensions that are data, not code: not worth scanning on write. */
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|avif|bmp|mp[34]|wav|ogg|webm|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|map|node)$/i;

/** Whether a written file is worth sending to the scanner (anything that is not a known binary asset). */
export const isScannableCodePath = (path: string): boolean => !BINARY_EXTENSIONS.test(path);
