// Timing + filesystem helpers for the Phase 0 baseline benchmark suite.
// Dependency-free Node ESM (Node >= 18). Windows-compatible: commands are
// spawned through a shell so `pnpm` resolves on PATH.

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a command with wall-clock timing.
 *
 * @param {string} cmd  command to run (e.g. "pnpm")
 * @param {string[]} args  arguments (e.g. ["test"])
 * @param {string} cwd  working directory for the command
 * @returns {Promise<{exitCode: number, durationMs: number, stdout: string, stderr: string}>}
 */
export async function timeCommand(cmd, args, cwd) {
  const start = performance.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    // Pass one shell string (not cmd+args) so Node does not emit DEP0190;
    // arguments here are fixed literals, not user input.
    const res = await execFileAsync([cmd, ...args].join(' '), {
      cwd,
      shell: true, // Windows: resolve .cmd shims (pnpm.cmd) via the shell
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
  } catch (err) {
    exitCode = typeof err.code === 'number' ? err.code : 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? (err.message ? String(err.message) : '');
  }
  const durationMs = Math.round(performance.now() - start);
  return { exitCode, durationMs, stdout, stderr };
}

/**
 * Recursively measure a directory: file count and total bytes.
 * Missing directories yield { fileCount: 0, totalBytes: 0 }.
 *
 * @param {string} dirPath
 * @returns {Promise<{fileCount: number, totalBytes: number}>}
 */
export async function dirStats(dirPath) {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir — nothing to measure
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          fileCount += 1;
          totalBytes += s.size;
        } catch {
          // file vanished mid-walk — skip
        }
      }
    }
  }

  await walk(dirPath);
  return { fileCount, totalBytes };
}
