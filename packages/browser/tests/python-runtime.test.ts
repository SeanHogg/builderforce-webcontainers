/**
 * Python processes on a real Pyodide (the pinned `pyodide` npm package): exit
 * codes and output, the project's files both ways, and installs — from an
 * offline fixture index, so install paths run without the network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, startFakeIndex, type FakeIndex } from './python-index.js';
import { pythonHost, readAll } from './python-helpers.js';

const SLOW = 120_000;
let index: FakeIndex;
beforeAll(async () => {
  index = await startFakeIndex(FIXTURES);
});
afterAll(() => index.close());

describe('Python processes', () => {
  it('runs a script with its arguments, output and exit code', { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'app.py': 'import sys, atexit\natexit.register(lambda: print("bye"))\nprint("hello", sys.argv[1:])\nprint("warn", file=sys.stderr)\nsys.exit(3)\n' });
    const proc = python.run('python', ['app.py', 'x']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(3);
    expect(output).toContain("hello ['x']\n");
    expect(output).toContain('warn\n');
    expect(output).toContain('bye\n');
    python.dispose();
  });

  it('runs -c code, and reports an uncaught exception as a traceback and exit 1', { timeout: SLOW }, async () => {
    const { python } = pythonHost();
    const ok = python.run('python3', ['-c', 'import json, os; print(json.dumps({"a": 1}), "HOME" in os.environ)']);
    expect(await readAll(ok.combinedOutput)).toBe('{"a": 1} True\n');
    expect(await ok.wait()).toBe(0);
    const failing = python.run('python', ['-c', 'raise ValueError("boom")']);
    expect(await readAll(failing.combinedOutput)).toMatch(/Traceback[\s\S]*ValueError: boom/);
    expect(await failing.wait()).toBe(1);
    python.dispose();
  });

  it('runs a -m module from the project, and a script named by its absolute project path', { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'tools/__init__.py': '', 'tools/greet.py': 'import sys\nprint("module", __name__, sys.argv[1:])\n', 'srv/abs.py': 'print(__file__)\n' });
    const module = python.run('python', ['-m', 'tools.greet', 'y']);
    expect(await readAll(module.combinedOutput)).toBe("module __main__ ['y']\n");
    const absolute = python.run('python', ['/srv/abs.py']);
    expect(await readAll(absolute.combinedOutput)).toBe('/project/srv/abs.py\n');
    expect(await absolute.wait()).toBe(0);
    python.dispose();
  });

  it('a missing script exits 2 with python\'s message', { timeout: SLOW }, async () => {
    const { python } = pythonHost();
    const proc = python.run('python', ['nope.py']);
    expect(await readAll(proc.combinedOutput)).toContain("can't open file 'nope.py'");
    expect(await proc.wait()).toBe(2);
    python.dispose();
  });

  it('a process killed while Pyodide loads exits at once and never serves', { timeout: SLOW }, async () => {
    const { ports, python } = pythonHost({ 'main.py': 'async def app(scope, receive, send):\n    pass\n' });
    const proc = python.run('uvicorn', ['main:app', '--port', '8090']);
    proc.kill();
    expect(await proc.wait()).toBe(143);
    expect(ports.has(8090)).toBe(false);
    python.dispose();
  });
});

describe("the project's files", () => {
  it('flow both ways from a service cwd: new, binary, removed, nothing from __pycache__', { timeout: SLOW }, async () => {
    const { fs, python } = pythonHost({
      'svc/data/in.txt': 'from the page',
      'svc/job.py': [
        'import os, pathlib',
        'text = pathlib.Path("data/in.txt").read_text()',
        'os.makedirs("out/deep", exist_ok=True)',
        'pathlib.Path("out/deep/result.txt").write_text(text.upper())',
        'pathlib.Path("out/bin.dat").write_bytes(bytes([0, 255, 1]))',
        'os.remove("data/in.txt")',
        'import helper; print(helper.VALUE, os.getcwd())',
      ].join('\n'),
      'svc/helper.py': 'VALUE = 42\n',
      'svc/node_modules/pkg/index.js': 'never copied into Python',
    });
    const proc = python.run('python', ['job.py'], { cwd: '/svc' });
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(0);
    expect(output).toBe('42 /project/svc\n');
    expect(fs.readText('/svc/out/deep/result.txt')).toBe('FROM THE PAGE');
    expect(fs.readFile('/svc/out/bin.dat')).toEqual(new Uint8Array([0, 255, 1]));
    expect(fs.exists('/svc/data/in.txt')).toBe(false);
    expect(fs.readText('/svc/node_modules/pkg/index.js')).toBe('never copied into Python');
    expect(fs.list().some((path) => path.includes('__pycache__'))).toBe(false);
    python.dispose();
  });

  it('renames, replacements, truncation, symlinks and a BOM reach the page', { timeout: SLOW }, async () => {
    const { fs, python } = pythonHost({ 'r.txt': 'old', 't.txt': 'truncate me', 't2.txt': 'xyz' });
    const proc = python.run('python', [
      '-c',
      [
        'import os, pathlib',
        'pathlib.Path("a.txt").write_text("A"); os.rename("a.txt", "b.txt")',
        'os.makedirs("d1"); pathlib.Path("d1/x.txt").write_text("X"); os.rename("d1", "d2")',
        'pathlib.Path("r.txt").write_text("new")',
        'f = open("t.txt", "r+"); f.truncate(2); f.close()',
        'os.truncate("t2.txt", 1)',
        'pathlib.Path("bom.txt").write_bytes(b"\\xef\\xbb\\xbfhi")',
        'os.symlink("b.txt", "link.txt")',
      ].join('\n'),
    ]);
    expect(await readAll(proc.combinedOutput)).toBe('');
    expect(await proc.wait()).toBe(0);
    expect(fs.exists('/a.txt')).toBe(false);
    expect(fs.readText('/b.txt')).toBe('A');
    expect(fs.exists('/d1/x.txt')).toBe(false);
    expect(fs.readText('/d2/x.txt')).toBe('X');
    expect(fs.readText('/r.txt')).toBe('new');
    expect(fs.readText('/t.txt')).toBe('tr');
    expect(fs.readText('/t2.txt')).toBe('x');
    expect(fs.readText('/bom.txt')).toBe('﻿hi');
    expect(fs.readText('/link.txt')).toBe('A');
    python.dispose();
  });
});

describe('installs (offline fixture index)', () => {
  it('declines a known native-only package by name, without downloading anything', { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'requirements.txt': 'psycopg2-binary==2.9.9\nuvicorn\n' });
    const proc = python.run('pip', ['install', '-r', 'requirements.txt']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(1);
    expect(output).toContain('Declined: "psycopg2-binary"');
    expect(output).toContain('pg8000');
    expect(output).toContain('Provided by the runtime (not installed): uvicorn');
    python.dispose();
  });

  it('pip install, then python in a new process, finds the package (the session record)', { timeout: SLOW }, async () => {
    const { python, kinds } = pythonHost({}, { PIP_INDEX_URL: index.url });
    const pip = python.run('pip', ['install', '--no-cache-dir', 'fixturepkg==1.0.0']);
    expect(await readAll(pip.combinedOutput)).toContain('Successfully installed fixturepkg');
    expect(await pip.wait()).toBe(0);
    // The index this install used (from PIP_INDEX_URL) is recorded with it, and only with it.
    expect(kinds.pipRecord.read()).toEqual([{ specs: ['fixturepkg==1.0.0'], indexUrls: [index.url] }]);
    const run = python.run('python', ['-c', 'import fixturepkg; print(fixturepkg.VALUE)']);
    expect(await readAll(run.combinedOutput)).toContain('fixture ok\n');
    expect(await run.wait()).toBe(0);
    python.dispose();
  });

  it("a recorded install's index never serves the project's requirements", { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'job/requirements.txt': 'needs-native\n', 'job/main.py': 'print("ran")\n' });
    const pip = python.run('pip', ['install', '-i', index.url, 'fixturepkg']);
    expect(await pip.wait()).toBe(0);
    const before = index.requests.length;
    const run = python.run('python', ['main.py'], { cwd: '/job' });
    const output = await readAll(run.combinedOutput);
    await run.wait();
    // fixturepkg was replayed from its own index; needs-native was looked up on PyPI only, never on that index.
    const asked = index.requests.slice(before);
    expect(asked.some((path) => path.startsWith('/simple/fixturepkg'))).toBe(true);
    expect(asked.some((path) => path.includes('needs-native') || path.includes('needs_native'))).toBe(false);
    expect(output).not.toContain('Successfully installed needs-native');
    python.dispose();
  });

  it('an install whose index is gone is a warning for later processes, not a failure', { timeout: SLOW }, async () => {
    const { python, kinds } = pythonHost();
    kinds.pipRecord.add({ specs: ['ghostpkg'], indexUrls: ['http://127.0.0.1:9/simple'] });
    const run = python.run('python', ['-c', 'print("still runs")']);
    const output = await readAll(run.combinedOutput);
    expect(await run.wait()).toBe(0);
    expect(output).toContain('Warning: could not repeat');
    expect(output).toContain('still runs\n');
    python.dispose();
  });

  it('a script whose shebang names Python runs as Python, from the host and from a shell', { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'manage.py': '#!/usr/bin/env python3\nimport sys\nprint("managed", sys.argv[1:])\n' });
    const direct = python.run('./manage.py', ['migrate']);
    expect(await readAll(direct.combinedOutput)).toBe("managed ['migrate']\n");
    expect(await direct.wait()).toBe(0);
    const shell = python.run('bfsh', ['-c', './manage.py check']);
    expect(await readAll(shell.combinedOutput)).toBe("managed ['check']\n");
    expect(await shell.wait()).toBe(0);
    python.dispose();
  });

  it("installs a script's project requirements first, hashes and line options stripped", { timeout: SLOW }, async () => {
    const { python } = pythonHost(
      { 'requirements.txt': 'fixturepkg==1.0.0 \\\n    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000\n', 'main.py': 'import fixturepkg\nprint(fixturepkg.VALUE)\n' },
      { PIP_INDEX_URL: index.url },
    );
    const proc = python.run('python', ['main.py']);
    expect(await readAll(proc.combinedOutput)).toContain('fixture ok\n');
    expect(await proc.wait()).toBe(0);
    python.dispose();
  });

  it('reads pyproject dependencies with extras, and pip install . installs them', { timeout: SLOW }, async () => {
    const { python } = pythonHost(
      { 'pyproject.toml': '[project]\nname = "demo"\ndependencies = [\n  "fixturepkg[speed]>=1.0",  # extras\n  "uvicorn[standard]>=0.30",\n]\n', 'empty/pyproject.toml': '[project]\nname = "empty"\n' },
      { PIP_INDEX_URL: index.url },
    );
    const pip = python.run('pip', ['install', '.']);
    expect(await readAll(pip.combinedOutput)).toContain('Successfully installed fixturepkg');
    expect(await pip.wait()).toBe(0);
    const empty = python.run('pip', ['install', '-e', './empty']);
    expect(await readAll(empty.combinedOutput)).toContain('./empty: no dependencies declared');
    expect(await empty.wait()).toBe(0);
    python.dispose();
  });

  it('a native-only dependency of another package is declined by name, and the package still installs', { timeout: SLOW }, async () => {
    const { python } = pythonHost({}, { PIP_INDEX_URL: index.url });
    const proc = python.run('python', ['-m', 'pip', 'install', 'needs-native', '-c', 'constraints.txt']);
    const output = await readAll(proc.combinedOutput);
    expect(output).toContain('Successfully installed needs-native');
    expect(output).toContain('Declined: "nativedep" has no pure-Python or Pyodide wheel');
    expect(await proc.wait()).toBe(1);
    python.dispose();
  });
});
