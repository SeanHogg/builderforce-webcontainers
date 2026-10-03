import { Kernel, type KernelOptions } from '../../src/system/kernel.js';
import { defaultPrograms } from '../../src/system/programs.js';
import type { FlatFiles } from '../../src/vfs.js';

export async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

export function kernelWith(files: FlatFiles = {}, options: Partial<KernelOptions> = {}): Kernel {
  const kernel = new Kernel({ programs: defaultPrograms(), ...options });
  kernel.fs.mount(files);
  return kernel;
}

/** Spawn and wait: output (stdout+stderr interleaved) and exit code. */
export async function exec(kernel: Kernel, command: string, args: string[] = [], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const proc = kernel.spawn(command, args, { cwd: options.cwd, env: options.env });
  if (options.input !== undefined) {
    const writer = proc.input.getWriter();
    await writer.write(options.input);
    await writer.close();
  }
  const [output, code] = await Promise.all([readAll(proc.output), proc.exit]);
  return { output, code };
}

export async function runNode(files: FlatFiles, entry = 'index.js', args: string[] = [], options: { input?: string } = {}) {
  const kernel = kernelWith(files);
  return { kernel, ...(await exec(kernel, 'node', [entry, ...args], options)) };
}
