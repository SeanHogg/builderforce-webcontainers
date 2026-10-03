/**
 * End to end against the real npm registry: `npm install express`, then an
 * Express app served on a virtual port. Needs the network, so it runs only when
 * BFWC_NETWORK=1 (CI stays offline and deterministic).
 */
import { describe, expect, it } from 'vitest';
import { exec, kernelWith, readAll } from '../node/helpers.js';
import { createMemoryCache } from '../../src/installer/registry.js';

const decode = (body?: Uint8Array) => new TextDecoder().decode(body);

describe.runIf(process.env.BFWC_NETWORK === '1')('real-world packages (network)', () => {
  it('installs express from npm and serves requests', async () => {
    const kernel = kernelWith(
      {
        'package.json': JSON.stringify({ name: 'hello', dependencies: { express: '^4.21.0' } }),
        'server.js': `
          const express = require('express');
          const app = express();
          app.use(express.json());
          app.get('/', (req, res) => res.send('Hello World!'));
          app.get('/json/:id', (req, res) => res.json({ id: req.params.id, q: req.query.q }));
          app.post('/echo', (req, res) => res.status(201).json(req.body));
          app.listen(3000, () => console.log('listening'));
        `,
      },
      { packageCache: createMemoryCache() },
    );
    const install = await exec(kernel, 'npm', ['install']);
    expect(install.output).toMatch(/added \d+ packages/);
    expect(install.code).toBe(0);

    const ready = new Promise<number>((resolve) => kernel.on('server-ready', (port) => resolve(port)));
    const proc = kernel.spawn('node', ['server.js']);
    const output = readAll(proc.output);
    expect(await ready).toBe(3000);

    const home = await kernel.request(3000, { url: '/' });
    expect(home?.status).toBe(200);
    expect(decode(home?.body)).toBe('Hello World!');
    expect(String(home?.headers['Content-Type'] ?? home?.headers['content-type'])).toMatch(/text\/html/);

    const json = await kernel.request(3000, { url: '/json/42?q=x' });
    expect(JSON.parse(decode(json?.body))).toEqual({ id: '42', q: 'x' });

    const echo = await kernel.request(3000, { method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"a":1}') });
    expect(`${echo?.status} ${decode(echo?.body).slice(0, 2000)}`).toMatch(/^201 /);
    expect(JSON.parse(decode(echo?.body))).toEqual({ a: 1 });

    expect((await kernel.request(3000, { url: '/missing' }))?.status).toBe(404);
    proc.kill();
    await proc.exit;
    expect(await output).toContain('listening');
  }, 180_000);
});
