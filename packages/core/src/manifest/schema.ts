/**
 * The published JSON Schema (draft 2020-12) of a v1 manifest, for editors and
 * external tooling. It matches `types.ts`; `validateManifest` is still the
 * authority (references between entries, cron, tiers are beyond a schema).
 */
import { APP_MANIFEST_SCHEMA_URL, ENVIRONMENT_TIERS, HTTP_METHODS, MANIFEST_TARGETS } from './types.js';

export { APP_MANIFEST_SCHEMA_URL };

const ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*$';
const DURATION_PATTERN = '^\\d+(ms|s|m|h|d)$';
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const keyedBy = (name: string) => ({ type: 'object', propertyNames: { pattern: ID_PATTERN }, additionalProperties: ref(name) });
const stringList = { type: 'array', items: { type: 'string' } };
const availability = { enum: ['session', 'always-on'] };

const resource = (type: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties: { type: { const: type }, ...properties },
  required: ['type', ...required],
  additionalProperties: false,
});

const readiness = (kind: string, value: unknown) => ({
  type: 'object',
  properties: { [kind]: value, timeout: ref('duration') },
  required: [kind],
  additionalProperties: false,
});

export const APP_MANIFEST_SCHEMA_V1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: APP_MANIFEST_SCHEMA_URL,
  title: 'Builderforce app manifest v1 (builderforce.json)',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    version: { const: 1 },
    name: { type: 'string' },
    resources: keyedBy('resource'),
    services: keyedBy('service'),
    jobs: keyedBy('job'),
    ingress: ref('ingress'),
    environments: { type: 'object', additionalProperties: ref('environment') },
    paths: ref('paths'),
  },
  required: ['version'],
  additionalProperties: false,
  $defs: {
    duration: { type: 'string', pattern: DURATION_PATTERN },
    resource: {
      oneOf: [
        resource('postgres', { persistent: { type: 'boolean' }, extensions: stringList, name: { type: 'string' } }),
        resource('redis', { persistent: { type: 'boolean' }, maxMemoryMb: { type: 'number', exclusiveMinimum: 0 } }),
        resource('queue', { engine: { enum: ['redis', 'native'] }, on: { type: 'string' } }, ['engine']),
        resource('object-storage'),
        resource('mail'),
        resource('graph', { engine: { enum: ['neo4j', 'memgraph', 'age'] } }, ['engine']),
        resource('connection', { connection: { type: 'string', minLength: 1 } }, ['connection']),
        resource('ai', { models: stringList }),
        resource('external', { module: { type: 'string', minLength: 1 }, outputs: stringList }, ['module']),
      ],
    },
    readiness: {
      oneOf: [
        readiness('http', { type: 'string', pattern: '^/' }),
        readiness('port', { const: true }),
        readiness('query', { const: true }),
        readiness('exitZero', { const: true }),
        readiness('started', { const: true }),
      ],
    },
    service: {
      type: 'object',
      properties: {
        runtime: { type: 'string', minLength: 1 },
        root: { type: 'string' },
        command: { type: 'string', minLength: 1 },
        args: stringList,
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        role: { enum: ['frontend', 'backend'] },
        uses: stringList,
        dependsOn: stringList,
        readiness: ref('readiness'),
        restart: { enum: ['never', 'on-failure', 'always'] },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        availability,
        scale: {
          type: 'object',
          properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 }, metric: { enum: ['concurrency', 'cpu', 'requests'] } },
          additionalProperties: false,
        },
      },
      required: ['runtime', 'command'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        schedule: { type: 'string', minLength: 1 },
        timezone: { type: 'string' },
        run: {
          type: 'object',
          properties: { service: { type: 'string' }, command: { type: 'string', minLength: 1 } },
          required: ['service', 'command'],
          additionalProperties: false,
        },
        invoke: {
          type: 'object',
          properties: { service: { type: 'string' }, method: { enum: [...HTTP_METHODS] }, path: { type: 'string', pattern: '^/' } },
          required: ['service', 'path'],
          additionalProperties: false,
        },
        concurrency: { enum: ['allow', 'forbid', 'replace'] },
        timeout: ref('duration'),
        missed: { enum: ['skip', 'run-once'] },
        availability,
      },
      required: ['schedule'],
      oneOf: [{ required: ['run'] }, { required: ['invoke'] }],
      additionalProperties: false,
    },
    ingress: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string', pattern: '^/' }, service: { type: 'string' } },
            required: ['path', 'service'],
            additionalProperties: false,
          },
        },
      },
      required: ['routes'],
      additionalProperties: false,
    },
    overrides: {
      type: 'object',
      properties: {
        services: { type: 'object', additionalProperties: { type: 'object' } },
        resources: { type: 'object', additionalProperties: { type: 'object' } },
        jobs: { type: 'object', additionalProperties: { type: 'object' } },
      },
      additionalProperties: false,
    },
    paths: {
      type: 'object',
      properties: {
        logs: { type: 'string', description: 'Project-relative. Default .builderforce/logs. No absolute path, no .. segment.' },
        diagnostics: { type: 'string', description: 'Project-relative. Default .builderforce/diagnostics. No absolute path, no .. segment.' },
        methodology: { type: 'string', description: 'Project-relative. Default .builderforce/methodology. No absolute path, no .. segment.' },
      },
      additionalProperties: false,
    },
    environment: {
      type: 'object',
      properties: {
        target: { enum: [...MANIFEST_TARGETS] },
        connection: { type: 'string' },
        tier: { enum: [...ENVIRONMENT_TIERS] },
        debug: { type: 'boolean' },
        overrides: ref('overrides'),
      },
      required: ['target', 'tier'],
      // debug only on non-production.
      if: { properties: { tier: { const: 'production' } } },
      then: { properties: { debug: { const: false } } },
      additionalProperties: false,
    },
  },
} as const;
