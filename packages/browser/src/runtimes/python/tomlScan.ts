/**
 * The two TOML reads dependency discovery needs, quote- and bracket-aware: a
 * table's body, and a key's array of strings — including strings that hold
 * brackets (`"uvicorn[standard]>=0.30"`), comments, and arrays spanning lines.
 * Not a TOML parser: anything else in the file is skipped, never interpreted.
 */

/** The body of table `[name]`, up to the next table header (`[x]` or `[[x]]` at the start of a line, outside any string or array). */
export function tomlTable(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start < 0) return undefined;
  let depth = 0;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (depth === 0 && /^\s*\[/.test(line)) break;
    depth = Math.max(0, depth + bracketBalance(line));
    body.push(line);
  }
  return body.join('\n');
}

/** Net `[` minus `]` on a line, outside strings and comments. */
function bracketBalance(line: string): number {
  let balance = 0;
  scan(line, 0, (char) => {
    if (char === '[') balance++;
    else if (char === ']') balance--;
    return true;
  });
  return balance;
}

/**
 * Walk `text` from `from`, calling `visit` for every character outside strings
 * and comments (stop by returning false); strings go to `onString`. Returns
 * the index where the walk stopped.
 */
function scan(text: string, from: number, visit: (char: string, index: number) => boolean, onString?: (value: string) => void): number {
  let i = from;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), i);
      const quote = triple ? char.repeat(3) : char;
      let j = i + quote.length;
      let value = '';
      while (j < text.length && !text.startsWith(quote, j)) {
        if (char === '"' && text[j] === '\\' && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
        } else value += text[j++];
      }
      onString?.(value);
      i = j + quote.length;
      continue;
    }
    if (!visit(char, i)) return i;
    i++;
  }
  return i;
}

/** The strings of `key = [ … ]` in a table body; empty when the key is missing or not an array. */
export function tomlStringArray(table: string, key: string): string[] {
  const match = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*\\[`, 'm').exec(table);
  if (!match) return [];
  const values: string[] = [];
  let depth = 1;
  scan(
    table,
    match.index + match[0].length,
    (char) => {
      if (char === '[') depth++;
      else if (char === ']') depth--;
      return depth > 0;
    },
    (value) => {
      if (depth === 1) values.push(value);
    },
  );
  return values;
}
