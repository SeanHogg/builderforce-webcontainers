/**
 * `util.inspect` and `util.format` — what `console.log` prints in Node. Close to
 * Node's output for the common shapes (nested objects to depth 2, arrays, Map,
 * Set, errors with stacks, Buffers, circular references); colours are ignored.
 */

export const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  showHidden?: boolean;
  sorted?: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function quote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(new RegExp(q, 'g'), '\\' + q) + q;
}

function formatKey(key: string | symbol): string {
  if (typeof key === 'symbol') return `[${key.toString()}]`;
  return IDENT.test(key) ? key : quote(key);
}

function wrap(open: string, items: string[], close: string, breakLength: number, indent: string): string {
  if (!items.length) return `${open}${close}`;
  const single = `${open} ${items.join(', ')} ${close}`;
  if (single.length + indent.length <= breakLength && !items.some((i) => i.includes('\n'))) return single;
  const inner = indent + '  ';
  return `${open}\n${items.map((i) => inner + i).join(',\n')}\n${indent}${close}`;
}

function constructorName(value: object): string | undefined {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return '[Object: null prototype]';
  const name = proto?.constructor?.name;
  return name && name !== 'Object' ? name : undefined;
}

export function inspect(value: unknown, options: InspectOptions = {}): string {
  const depth = options.depth === null ? Infinity : options.depth ?? 2;
  const breakLength = options.breakLength ?? 80;
  const seen: object[] = [];

  const fmt = (v: unknown, level: number, indent: string, nested: boolean): string => {
    switch (typeof v) {
      case 'string': return nested ? quote(v) : v;
      case 'number': return Object.is(v, -0) ? '-0' : String(v);
      case 'bigint': return `${v}n`;
      case 'boolean': return String(v);
      case 'undefined': return 'undefined';
      case 'symbol': return v.toString();
      case 'function': {
        const name = v.name ? `: ${v.name}` : ' (anonymous)';
        const kind = /^class\s/.test(Function.prototype.toString.call(v)) ? 'class' : 'Function';
        const keys = Object.keys(v);
        const base = kind === 'class' ? `[class ${v.name || '(anonymous)'}]` : `[${kind}${name}]`;
        if (!keys.length || level > depth) return base;
        return wrap(`${base} {`, keys.map((k) => `${formatKey(k)}: ${fmt((v as any)[k], level + 1, indent + '  ', true)}`), '}', breakLength, indent);
      }
    }
    if (v === null) return 'null';
    const obj = v as Record<string | symbol, unknown>;
    const custom = obj[inspectCustom];
    if (typeof custom === 'function') {
      const result = custom.call(obj, depth - level, { ...options, stylize: (s: string) => s }, inspect);
      return typeof result === 'string' ? result : fmt(result, level, indent, nested);
    }
    if (seen.includes(obj)) return '[Circular *1]';
    if (v instanceof Error) {
      const stack = v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}${v.stack ? '\n' + v.stack.split('\n').slice(1).join('\n') : ''}`;
      const extra = Object.keys(v).filter((k) => k !== 'stack' && k !== 'message');
      if (!extra.length || level > depth) return stack;
      seen.push(obj);
      const out = wrap(`${stack} {`, extra.map((k) => `${formatKey(k)}: ${fmt(obj[k], level + 1, indent + '  ', true)}`), '}', breakLength, indent);
      seen.pop();
      return out;
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Promise) return 'Promise { <pending> }';
    if (v instanceof WeakMap) return 'WeakMap { <items unknown> }';
    if (v instanceof WeakSet) return 'WeakSet { <items unknown> }';
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const bytes = v as unknown as ArrayLike<number> & { constructor: { name: string } };
      if (bytes.constructor.name === 'Buffer') {
        const hex = Array.from(bytes as Uint8Array).slice(0, 50).map((b) => b.toString(16).padStart(2, '0'));
        return `<Buffer${hex.length ? ' ' + hex.join(' ') : ''}${bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : ''}>`;
      }
      return `${bytes.constructor.name}(${bytes.length}) [ ${Array.from(bytes).slice(0, 100).join(', ')} ]`;
    }
    if (level > depth) {
      if (Array.isArray(v)) return '[Array]';
      return `[${constructorName(obj) ?? 'Object'}]`;
    }

    seen.push(obj);
    const next = (x: unknown) => fmt(x, level + 1, indent + '  ', true);
    let out: string;
    if (Array.isArray(v)) {
      const items = v.slice(0, 100).map(next);
      if (v.length > 100) items.push(`... ${v.length - 100} more items`);
      for (const k of Object.keys(v)) if (!/^\d+$/.test(k)) items.push(`${formatKey(k)}: ${next(obj[k])}`);
      const prefix = constructorName(obj) && constructorName(obj) !== 'Array' ? `${constructorName(obj)}(${v.length}) ` : '';
      out = wrap(`${prefix}[`, items, ']', breakLength, indent);
    } else if (v instanceof Map) {
      out = wrap(`Map(${v.size}) {`, [...v].map(([k, val]) => `${next(k)} => ${next(val)}`), '}', breakLength, indent);
    } else if (v instanceof Set) {
      out = wrap(`Set(${v.size}) {`, [...v].map(next), '}', breakLength, indent);
    } else {
      const keys: Array<string | symbol> = [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj).filter((s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable)];
      if (options.sorted) keys.sort();
      const items = keys.map((k) => {
        const desc = Object.getOwnPropertyDescriptor(obj, k);
        const shown = desc && (desc.get || desc.set) ? (desc.get && desc.set ? '[Getter/Setter]' : desc.get ? '[Getter]' : '[Setter]') : next(obj[k]);
        return `${formatKey(k)}: ${shown}`;
      });
      const name = constructorName(obj);
      const tag = (obj as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
      const prefix = name ? `${name}${tag && tag !== name ? ` [${tag}]` : ''} ` : tag ? `Object [${tag}] ` : '';
      out = items.length || !prefix ? wrap(`${prefix}{`, items, '}', breakLength, indent) : `${prefix}{}`;
    }
    seen.pop();
    return out;
  };

  return fmt(value, 0, '', false);
}
inspect.custom = inspectCustom;
inspect.defaultOptions = { depth: 2 } as InspectOptions;

/** printf-style `util.format`: %s %d %i %f %j %o %O %c %%. */
export function format(...args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== 'string') return args.map((a) => inspect(a)).join(' ');
  let i = 0;
  let out = first.replace(/%([sdifjoOc%])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    if (i >= rest.length) return match;
    const arg = rest[i++];
    switch (spec) {
      case 's': return typeof arg === 'string' ? arg : typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'object' && arg !== null ? inspect(arg, { depth: 1 }) : String(arg);
      case 'd': return typeof arg === 'bigint' ? `${arg}n` : String(Number(arg));
      case 'i': return typeof arg === 'bigint' ? `${arg}n` : String(parseInt(String(arg), 10));
      case 'f': return String(parseFloat(String(arg)));
      case 'j':
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      case 'c': return '';
      default: return inspect(arg, { depth: spec === 'o' ? 4 : 2 });
    }
  });
  for (; i < rest.length; i++) {
    const arg = rest[i];
    out += ' ' + (typeof arg === 'string' ? arg : inspect(arg));
  }
  return out;
}
