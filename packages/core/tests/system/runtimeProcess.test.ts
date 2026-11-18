import { describe, expect, it } from 'vitest';
import { kernelWith } from '../node/helpers.js';

describe('RuntimeProcess output', () => {
  it('regression: cancelling combinedOutput before the process exits does not throw when it exits', async () => {
    const kernel = kernelWith({ 'slow.js': 'setTimeout(() => console.log("late"), 20);' });
    const proc = kernel.run('node', ['slow.js']);
    await proc.combinedOutput.cancel();
    // Before the fix, the exit closed the cancelled stream: ERR_INVALID_STATE as an unhandled rejection.
    expect(await proc.wait()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
