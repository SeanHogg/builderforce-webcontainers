/**
 * Case-insensitive access to a plain header record (`Record<name, value>`), the
 * shape responses take on the wire between the page and the service worker. A
 * record may hold one header under several spellings (`Content-Type` and
 * `content-type`): every helper here sees all of them. The one helper for it —
 * never a local `Object.keys(...).find(...)` copy.
 */

/** Every key of `headers` that names `name`, whatever its case. */
export function headerKeys(headers: Readonly<Record<string, unknown>>, name: string): string[] {
  const wanted = name.toLowerCase();
  return Object.keys(headers).filter((key) => key.toLowerCase() === wanted);
}

/** The first key of `headers` that names `name`, whatever its case. */
export function headerKey(headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  return headerKeys(headers, name)[0];
}

/** `headers` without any spelling of `name`. */
export function withoutHeader<V>(headers: Readonly<Record<string, V>>, name: string): Record<string, V> {
  const out = { ...headers };
  for (const key of headerKeys(headers, name)) delete out[key];
  return out;
}
