/** HTTP against a virtual port, buffered — shared by every runtime's tests (PHP, .NET, Rust). */
import type { ProcessHost } from '../src/node/processHost.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function request(ports: ProcessHost['ports'], port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const response = await ports.requestBuffered(port, { method, url, headers, body: body === undefined ? null : encoder.encode(body) });
  if (!response) throw new Error(`Nothing listens on ${port}`);
  return { status: response.status, headers: response.headers, text: decoder.decode(response.body) };
}
