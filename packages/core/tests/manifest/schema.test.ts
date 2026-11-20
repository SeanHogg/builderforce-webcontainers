/** The published schema accepts the design's example and refuses the obvious mistakes (a tiny structural checker, no new deps). */
import { describe, expect, it } from 'vitest';
import { APP_MANIFEST_SCHEMA_URL, APP_MANIFEST_SCHEMA_V1 } from '../../src/manifest/index.js';
import { DESIGN_EXAMPLE_JSON } from './fixtures.js';

type Schema = Record<string, any>;
const root = APP_MANIFEST_SCHEMA_V1 as unknown as Schema;

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Errors for `value` against `schema`: the subset of draft 2020-12 the manifest schema uses. */
function check(schema: Schema, value: unknown, path = '$'): string[] {
  if (schema.$ref) return check(root.$defs[(schema.$ref as string).replace('#/$defs/', '')], value, path);
  const errors: string[] = [];
  const type = typeOf(value);
  if (schema.type && !(schema.type === type || (schema.type === 'number' && type === 'integer'))) return [`${path}: expected ${schema.type}`];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of ${schema.enum.join('|')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: not above ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...check(schema.items, item, `${path}[${index}]`)));
  if (type === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key)) errors.push(`${path}.${key}: bad key`);
      if (schema.properties?.[key]) errors.push(...check(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...check(schema.additionalProperties, item, `${path}.${key}`));
    }
  }
  if (schema.oneOf) {
    const passing = (schema.oneOf as Schema[]).filter((option) => check(option, value, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
  }
  if (schema.if && check(schema.if, value, path).length === 0 && schema.then) errors.push(...check(schema.then, value, path));
  return errors;
}

describe('APP_MANIFEST_SCHEMA_V1', () => {
  it('is draft 2020-12 with the canonical $id', () => {
    expect(root.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(root.$id).toBe(APP_MANIFEST_SCHEMA_URL);
    expect(APP_MANIFEST_SCHEMA_URL).toBe('https://builderforce.ai/schema/app.v1.json');
  });

  it("accepts the design's example manifest", () => {
    expect(check(root, JSON.parse(DESIGN_EXAMPLE_JSON))).toEqual([]);
  });

  it('refuses the obvious mistakes', () => {
    const example = () => JSON.parse(DESIGN_EXAMPLE_JSON);
    const withChange = (edit: (m: any) => void) => {
      const manifest = example();
      edit(manifest);
      return check(root, manifest);
    };
    expect(withChange((m) => (m.version = 2))).not.toEqual([]);
    expect(withChange((m) => (m.resources.db.type = 'mongodb'))).not.toEqual([]);
    expect(withChange((m) => (m.services.api.port = 70000))).not.toEqual([]);
    expect(withChange((m) => (m.services.api.readiness = { http: '/h', port: true }))).not.toEqual([]);
    expect(withChange((m) => (m.jobs.poll.run = { service: 'api', command: 'x' }))).not.toEqual([]);
    expect(withChange((m) => (m.environments.prod.debug = true))).not.toEqual([]);
    expect(withChange((m) => (m.environments.local.target = 'heroku'))).not.toEqual([]);
    expect(withChange((m) => delete m.services.web.command)).not.toEqual([]);
  });
});
