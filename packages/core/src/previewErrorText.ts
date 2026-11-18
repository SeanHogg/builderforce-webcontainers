/**
 * Plain text for an error a preview reported. The bridge posts what the page
 * raised, raw; this is the one place it is cleaned up for the host:
 *   • ANSI colour escapes (some dev tooling logs with them) are removed;
 *   • a framework runtime error code — Angular's `NG0303`, `NG0202`, `NG02100` —
 *     becomes `code`, and `message` becomes the first line carrying it, without
 *     the `Error: ` / `RuntimeError: ` / `ERROR ` prefixes the console and
 *     Angular's ErrorHandler put in front.
 * A message with no code keeps its text.
 */

export interface PreviewErrorText {
  message: string;
  /** The framework error code (`NG0303`), when the message or stack names one. */
  code?: string;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Angular runtime (`NG0303`, `NG02100`) and compiler (`NG8001`) codes. */
const ANGULAR_CODE = /\bNG\d{4,5}\b/;
const LEADING_NOISE = /^(?:\s*(?:ERROR\b:?|[A-Za-z]*Error:|Uncaught(?: \(in promise\))?:?))+\s*/;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

export function previewErrorText(message: string, stack?: string): PreviewErrorText {
  const clean = stripAnsi(message);
  for (const text of [clean, stack ? stripAnsi(stack) : '']) {
    const match = ANGULAR_CODE.exec(text);
    if (!match) continue;
    const line = text.split('\n').find((candidate) => candidate.includes(match[0]))!;
    return { message: line.replace(LEADING_NOISE, '').trim(), code: match[0] };
  }
  return { message: clean };
}
