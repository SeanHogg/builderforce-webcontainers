import type { ComponentRequest } from '../components.js';
import { styleLanguageOf } from '../styles/languages.js';
import { maskCode, matchBracket, skipSpace, splitTopLevel, trimRange } from './scanner.js';
import { applyEdits, findDecoratorCalls, objectProperties, stringLiteralValue, type Edit, type ObjectProperty } from './syntax.js';
import type { ScannedSource } from './imports.js';

/**
 * Inline a component's external resources, as the Angular CLI does in JIT mode:
 * in every `@Component({…})`, `templateUrl` becomes `template: "<file>"`, and
 * `styleUrl` / `styleUrls` become compiled CSS strings in `styles` (after any
 * inline styles the component already has). Angular's JIT compiler would
 * otherwise try to fetch the URLs at runtime, relative to the page.
 */
export type ResourceRequest = Pick<ComponentRequest, 'path' | 'readResource' | 'compileStylesheet'>;

function literalOf(source: string, property: ObjectProperty): string | undefined {
  return property.value && stringLiteralValue(source.slice(property.value.start, property.value.end));
}

/** The URLs of a `styleUrls: ['a.css', "b.scss"]` array. */
function styleUrlList(source: string, masked: string, property: ObjectProperty, path: string): string[] {
  const value = property.value!;
  if (masked[value.start] !== '[') throw new Error(`${path}: styleUrls must be an array of string literals.`);
  return splitTopLevel(masked, value.start + 1, value.end - 1).map((part) => {
    const range = trimRange(masked, part);
    const url = stringLiteralValue(source.slice(range.start, range.end));
    if (url === undefined) throw new Error(`${path}: styleUrls must be an array of string literals.`);
    return url;
  });
}

function readOrThrow(request: ResourceRequest, field: string, url: string): string {
  const text = request.readResource?.(url);
  if (text === undefined) throw new Error(`${request.path}: ${field} '${url}' not found`);
  return text;
}

async function compileStyle(request: ResourceRequest, field: string, url: string): Promise<string> {
  const text = readOrThrow(request, field, url);
  if (request.compileStylesheet) return request.compileStylesheet(url);
  if (styleLanguageOf(url) === 'css') return text;
  throw new Error(`${request.path}: ${field} '${url}' needs a CSS preprocessor, and none is configured.`);
}

/** The items of an existing `styles` value (a string, or an array of them) as source text. */
function existingStyles(source: string, masked: string, property: ObjectProperty): string[] {
  const value = property.value!;
  if (masked[value.start] !== '[') return [source.slice(value.start, value.end)];
  return splitTopLevel(masked, value.start + 1, value.end - 1).map((part) => {
    const range = trimRange(masked, part);
    return source.slice(range.start, range.end);
  });
}

/**
 * Remove a property with its trailing comma, keeping line breaks. The last
 * property leaves the comma before it as a (valid) trailing comma, so two
 * removals never claim the same comma.
 */
function removal(masked: string, property: ObjectProperty): Edit {
  const { start } = property.range;
  const after = skipSpace(masked, property.range.end);
  const end = masked[after] === ',' ? after + 1 : property.range.end;
  return { start, end, text: masked.slice(start, end).replace(/[^\n]/g, '') };
}

/** The edits inlining every `@Component`'s resources (see {@link ScannedSource}). */
export async function resourceEdits({ source, masked }: Pick<ScannedSource, 'source' | 'masked'>, request: ResourceRequest): Promise<Edit[]> {
  const edits: Edit[] = [];
  if (!/\b(templateUrl|styleUrls?)\b/.test(source)) return edits;

  for (const call of findDecoratorCalls(masked, ['Component'])) {
    const open = skipSpace(masked, call.open + 1);
    if (masked[open] !== '{') continue;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const properties = objectProperties(source, masked, open, close);
    const byKey = (key: string) => properties.find((property) => property.key === key);

    const template = byKey('templateUrl');
    if (template) {
      const url = literalOf(source, template);
      if (url === undefined) throw new Error(`${request.path}: templateUrl must be a string literal.`);
      edits.push({ start: template.range.start, end: template.range.end, text: `template: ${JSON.stringify(readOrThrow(request, 'templateUrl', url))}` });
    }

    const single = byKey('styleUrl');
    const list = byKey('styleUrls');
    if (!single && !list) continue;
    const urls: Array<{ field: string; url: string }> = [];
    if (single) {
      const url = literalOf(source, single);
      if (url === undefined) throw new Error(`${request.path}: styleUrl must be a string literal.`);
      urls.push({ field: 'styleUrl', url });
    }
    if (list) for (const url of styleUrlList(source, masked, list, request.path)) urls.push({ field: 'styleUrls', url });
    const compiled: string[] = [];
    for (const { field, url } of urls) compiled.push(JSON.stringify(await compileStyle(request, field, url)));

    const inline = byKey('styles');
    const styles = `styles: [${[...(inline ? existingStyles(source, masked, inline) : []), ...compiled].join(', ')}]`;
    // The first url property becomes `styles`; the other url property and the old `styles` go.
    const [first, ...rest] = [single, list].filter((p): p is ObjectProperty => !!p).sort((a, b) => a.range.start - b.range.start);
    edits.push({ start: first!.range.start, end: first!.range.end, text: styles });
    for (const property of [...rest, ...(inline ? [inline] : [])]) edits.push(removal(masked, property));
  }
  return edits;
}

export async function inlineResources(source: string, request: ResourceRequest): Promise<string> {
  const edits = await resourceEdits({ source, masked: maskCode(source) }, request);
  return edits.length ? applyEdits(source, edits) : source;
}

