/** A browser-runnable manifest with the `agents` capability and three agents declared by role. */
import type { AppManifest } from '../../src/manifest/index.js';
import { reactNodePostgres } from './fixtures.js';

export function agentsManifest(): AppManifest {
  const manifest = reactNodePostgres();
  return {
    ...manifest,
    // Only the browser environment: `aws` has no `ai` delivery yet, which is its own warning.
    environments: { local: manifest.environments!.local! },
    capabilities: { agents: { maxAgents: 3, tools: ['env.fs.read', 'env.fs.write', 'env.run', 'env.services.status'], budget: { tokens: 200000 } } },
    agents: {
      coordinator: { role: 'coordinator', triggers: [{ manual: true }] },
      developer: {
        role: 'developer',
        instructions: 'agents/developer.md',
        tools: ['env.fs.read', 'env.fs.write', 'env.run'],
        triggers: [{ cron: '0 3 * * *', timezone: 'UTC' }],
        budget: { tokens: 100000 },
      },
      tester: { workload: 'test', memory: 'tests', tools: ['env.services.status'], triggers: [{ service: 'api', event: 'deployed' }] },
    },
  };
}
