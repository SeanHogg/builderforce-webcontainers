import { describe, expect, it, vi } from 'vitest';
import { bridgeWorker, workerOverPort } from '../src/relayWorker.js';

/** The slice of a Worker the bridge drives, recording what reaches it. */
function fakeWorker() {
  const received: unknown[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message: string }) => void) | null,
    postMessage: (data: unknown) => { received.push(data); },
    terminate: vi.fn(),
  };
  return { worker, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('process workers bridged through the relay', () => {
  it('carries messages both ways, so the process host cannot tell it from a local worker', async () => {
    const channel = new MessageChannel();
    const { worker, received } = fakeWorker();
    bridgeWorker(channel.port2, worker as unknown as Worker);
    const host = workerOverPort(channel.port1);
    const replies: unknown[] = [];
    host.onmessage = (event) => replies.push(event.data);

    host.postMessage({ type: 'spawn', command: 'node' });
    await settle();
    expect(received).toEqual([{ type: 'spawn', command: 'node' }]);

    worker.onmessage?.({ data: { type: 'stdout', chunk: 'hi' } });
    await settle();
    expect(replies).toEqual([{ type: 'stdout', chunk: 'hi' }]);
    host.terminate();
  });

  it('reports a worker failure to the host', async () => {
    const channel = new MessageChannel();
    const { worker } = fakeWorker();
    bridgeWorker(channel.port2, worker as unknown as Worker);
    const host = workerOverPort(channel.port1);
    const errors: Array<string | undefined> = [];
    host.onerror = (event) => errors.push(event.message);

    worker.onerror?.({ message: 'boom' });
    await settle();
    expect(errors).toEqual(['boom']);
    host.terminate();
  });

  it('terminates the real worker when the host does', async () => {
    const channel = new MessageChannel();
    const { worker } = fakeWorker();
    bridgeWorker(channel.port2, worker as unknown as Worker);
    workerOverPort(channel.port1).terminate();
    await settle();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
