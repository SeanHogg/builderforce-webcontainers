/** The design's example manifest (PRD 31 §W11 "Contract — manifest v1"), verbatim, and a browser-runnable one. */
import type { AppManifest } from '../../src/manifest/index.js';

export const DESIGN_EXAMPLE_JSON = `{
  "$schema": "https://builderforce.ai/schema/app.v1.json",
  "version": 1,
  "name": "acme-shop",
  "resources": {
    "db":    { "type": "postgres", "persistent": true, "extensions": ["vector"] },
    "cache": { "type": "redis", "persistent": true, "maxMemoryMb": 64 },
    "tasks": { "type": "queue", "engine": "redis", "on": "cache" },
    "files": { "type": "object-storage" },
    "mail":  { "type": "mail" }
  },
  "services": {
    "api":    { "runtime": "node", "root": "/api", "command": "npm start", "port": 8000, "uses": ["db", "cache", "files", "mail"],
                "readiness": { "http": "/health" }, "scale": { "min": 1, "max": 4, "metric": "concurrency" } },
    "worker": { "runtime": "python", "root": "/worker", "command": "rq worker", "uses": ["tasks", "db"], "restart": "always" },
    "web":    { "runtime": "node", "root": "/web", "command": "npm run dev", "port": 5173, "role": "frontend", "dependsOn": ["api"] }
  },
  "jobs": {
    "nightly": { "schedule": "0 3 * * *", "timezone": "UTC", "run": { "service": "worker", "command": "python digest.py" },
                 "concurrency": "forbid", "timeout": "10m", "missed": "skip", "availability": "always-on" },
    "poll":    { "schedule": "*/5 * * * *", "invoke": { "service": "api", "method": "POST", "path": "/internal/poll" } }
  },
  "ingress": { "routes": [ { "path": "/api", "service": "api" }, { "path": "/", "service": "web" } ] },
  "environments": {
    "local":   { "target": "browser", "tier": "non-production", "debug": true },
    "staging": { "target": "cloudflare", "connection": "cf-acme", "tier": "non-production" },
    "prod":    { "target": "aws", "connection": "aws-acme", "tier": "production",
                 "overrides": { "services": { "api": { "scale": { "min": 2, "max": 10 } } } } }
  }
}`;

/** React + Node + Postgres: everything the browser target runs today. */
export function reactNodePostgres(): AppManifest {
  return {
    version: 1,
    name: 'react-node',
    resources: { db: { type: 'postgres', persistent: true } },
    services: {
      api: { runtime: 'node', root: '/api', command: 'npm start', port: 8000, uses: ['db'], readiness: { http: '/health', timeout: '30s' } },
      web: { runtime: 'node', root: '/web', command: 'npm run dev', port: 5173, role: 'frontend', dependsOn: ['api'] },
    },
    environments: {
      local: { target: 'browser', tier: 'non-production', debug: true },
      prod: { target: 'aws', connection: 'aws-acme', tier: 'production', overrides: { services: { api: { scale: { min: 2 } } } } },
    },
  };
}
