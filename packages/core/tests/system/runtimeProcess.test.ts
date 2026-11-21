import { describe, expect, it } from 'vitest';
import { toRuntimeProcess } from '../../src/system/process.js';
import type { ChildHandle, StdioChunk } from '../../src/system/types.js';
import { kernelWith } from '../node/helpers.js';

/** A child whose output the test writes, and whose exit it settles. */
function scriptedChild() {
  const out = new Set<(chunk: StdioChunk) => void>();
  const err = new Set<(chunk: StdioChunk) => void>();
  let exit!: (code: number) => void;
  const child: ChildHandle = {
    pid: 1,
    onStdout: (listener) => (out.add(listener), () => out.delete(listener)),
    onStderr: (listener) => (err.add(listener), () => err.delete(listener)),
    write: () => undefined,
    closeStdin: () => undefined,
    kill: () => undefined,
    exit: new Promise<number>((resolve) => (exit = resolve)),
  };
  return { child, stdout: (chunk: StdioChunk) => out.forEach((l) => l(chunk)), stderr: (chunk: StdioChunk) => err.forEach((l) => l(chunk)), exit: (code: number) => exit(code) };
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  for (const reader = stream.getReader(); ; ) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

describe('RuntimeProcess output', () => {
  it('ends after the exit with everything written before it: the last line without its newline, bytes the decoder still held', async () => {
    const { child, stdout, stderr, exit } = scriptedChild();
    const proc = toRuntimeProcess(child, false);
    const output = readAll(proc.combinedOutput);
    stdout('first\n');
    stderr(new TextEncoder().encode('warn\n'));
    stdout(new Uint8Array([0x6c, 0x61, 0x73, 0x74, 0xe2, 0x82])); // "last" + a truncated "€"
    exit(0);
    // Before the fix the decoder's held bytes were dropped at the exit: the stream ended at "last".
    expect(await output).toBe('first\nwarn\nlast�');
    expect(await proc.wait()).toBe(0);
  });

  it('ends after a nested child’s last write, relayed by its parent', async () => {
    const kernel = kernelWith({ 'parent.js': "require('child_process').spawn('node', ['child.js'], { stdio: 'inherit' }).on('exit', (code) => process.exit(code));", 'child.js': "process.stdout.write('child-last');" });
    const proc = kernel.run('node', ['parent.js']);
    expect(await readAll(proc.combinedOutput)).toBe('child-last');
    expect(await proc.wait()).toBe(0);
  });

  it('regression: cancelling combinedOutput before the process exits does not throw when it exits', async () => {
    const kernel = kernelWith({ 'slow.js': 'setTimeout(() => console.log("late"), 20);' });
    const proc = kernel.run('node', ['slow.js']);
    await proc.combinedOutput.cancel();
    // Before the fix, the exit closed the cancelled stream: ERR_INVALID_STATE as an unhandled rejection.
    expect(await proc.wait()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
