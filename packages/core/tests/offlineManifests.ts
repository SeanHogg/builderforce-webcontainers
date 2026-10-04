/**
 * The default CDN factory fetches each declared package's `package.json` from esm.sh
 * to decide its pins. Tests answer those requests here so they never touch the
 * network, with the one relationship the fixtures depend on: react-dom imports
 * react. Every other request goes to the real `fetch`.
 */
import { vi } from 'vitest';

const MANIFESTS: Record<string, object> = {
  'react-dom': { peerDependencies: { react: '^18.3.1' } },
};

const MANIFEST_URL = /^https:\/\/esm\.sh\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/package\.json$/;
const realFetch = globalThis.fetch;

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const match = MANIFEST_URL.exec(url);
  if (match) return new Response(JSON.stringify(MANIFESTS[match[1]!] ?? {}), { status: 200 });
  return realFetch(input, init);
});
