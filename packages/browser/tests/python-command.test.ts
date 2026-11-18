/**
 * The Python runtime's pure half: what a command line asks for, what a
 * project's requirements are, which ones are declined (by name) or provided,
 * whether the `python` provider accepts a service, and the session's pip record.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import {
  acceptsPythonService,
  fromPyodidePath,
  headersOf,
  isPythonCommand,
  mapInvocationPaths,
  packagesWithoutWheels,
  parsePyproject,
  parsePythonCommand,
  parseRequirementsTxt,
  planRequirements,
  readProjectRequirements,
  toPyodidePath,
  tomlStringArray,
} from '../src/runtimes/python/index.js';

const invocation = (command: string, args: string[], env: Record<string, string> = {}) => {
  const parsed = parsePythonCommand(command, args, env);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.invocation;
};
const install = (packages: string[] = [], files: string[] = [], projects: string[] = [], indexUrls: string[] = []) => ({ kind: 'install', packages, files, projects, indexUrls });

describe('parsePythonCommand', () => {
  it('reads scripts, -c code and -m modules the way python does', () => {
    expect(invocation('python', ['-u', 'app.py', '--flag'])).toEqual({ kind: 'script', path: 'app.py', argv: ['app.py', '--flag'] });
    expect(invocation('python3', ['-W', 'ignore', '-c', 'print(1)', 'a'])).toEqual({ kind: 'code', code: 'print(1)', argv: ['-c', 'a'] });
    expect(invocation('/usr/bin/python3.12', ['-m', 'mypkg.tool', 'x'])).toEqual({ kind: 'module', module: 'mypkg.tool', argv: ['mypkg.tool', 'x'] });
    expect(parsePythonCommand('python', [])).toMatchObject({ ok: false, reason: expect.stringContaining('terminal') });
  });

  it('reads pip install: files, valued options that consume their values, indexes, project directories', () => {
    expect(invocation('pip', ['install', '-r', 'requirements.txt', 'flask==3.0'])).toEqual(install(['flask==3.0'], ['requirements.txt']));
    expect(invocation('python', ['-m', 'pip', 'install', '--requirement=req.txt'])).toEqual(install([], ['req.txt']));
    expect(invocation('pip', ['install', '-c', 'constraints.txt', '-t', 'vendor', '--hash', 'x', '--config-settings', 'k=v', 'pg8000'])).toEqual(install(['pg8000']));
    expect(invocation('pip', ['install', '--extra-index-url', 'https://b/simple', '-i', 'https://a/simple', 'x'])).toEqual(install(['x'], [], [], ['https://a/simple', 'https://b/simple']));
    expect(invocation('pip', ['install', '.'])).toEqual(install([], [], ['.']));
    expect(invocation('pip', ['install', '-e', './api'])).toEqual(install([], [], ['./api']));
    expect(parsePythonCommand('pip', ['install', '-e', 'git+https://x/y.git'])).toMatchObject({ ok: false, reason: expect.stringContaining('Editable') });
    expect(parsePythonCommand('pip', ['install', '-c', 'constraints.txt'])).toMatchObject({ ok: false, reason: expect.stringContaining('needs a package') });
    expect(parsePythonCommand('pip', ['freeze'])).toMatchObject({ ok: false });
  });

  it('turns app-server command lines into request-driven app specs', () => {
    expect(invocation('uvicorn', ['main:app', '--host', '0.0.0.0', '--port', '8000', '--reload'])).toEqual({ kind: 'serve', server: { interface: 'asgi', app: 'main:app', port: 8000 } });
    expect(invocation('python', ['-m', 'uvicorn', 'pkg.api:create', '--factory', '--app-dir', 'src'], { PORT: '9000' })).toEqual({
      kind: 'serve',
      server: { interface: 'asgi', app: 'pkg.api:create', port: 9000, factory: true, appDir: 'src' },
    });
    expect(invocation('gunicorn', ['-w', '2', '-b', '0.0.0.0:8001', 'wsgi:application'])).toEqual({ kind: 'serve', server: { interface: 'wsgi', app: 'wsgi:application', port: 8001 } });
    expect(invocation('gunicorn', ['-k', 'uvicorn.workers.UvicornWorker', 'main:app'])).toMatchObject({ server: { interface: 'asgi', port: 8000 } });
    expect(invocation('flask', ['--app', 'hello', 'run', '-p', '5001'])).toEqual({ kind: 'serve', server: { interface: 'wsgi', app: 'hello', port: 5001 } });
    expect(invocation('flask', ['run'], { FLASK_APP: 'site:make()' })).toEqual({ kind: 'serve', server: { interface: 'wsgi', app: 'site:make', port: 5000, factory: true } });
    expect(invocation('fastapi', ['run', 'app/main.py', '--port', '8080'])).toEqual({ kind: 'serve', server: { interface: 'asgi', app: 'main', port: 8080, appDir: 'app' } });
    expect(invocation('waitress-serve', ['--listen=*:8081', 'app:app'])).toMatchObject({ server: { interface: 'wsgi', port: 8081 } });
    expect(parsePythonCommand('uvicorn', ['main:app', '--port', 'abc'])).toMatchObject({ ok: false, reason: expect.stringContaining('Invalid port') });
    expect(parsePythonCommand('uvicorn', ['--port', '8000'])).toMatchObject({ ok: false, reason: expect.stringContaining('no application') });
  });

  it("prefers the module:app positional, never leaks an unknown option's value, honours --interface", () => {
    expect(invocation('uvicorn', ['--some-new-option', 'value', 'main:app'])).toMatchObject({ server: { app: 'main:app' } });
    expect(invocation('gunicorn', ['--some-new-option', 'value', 'wsgi'])).toMatchObject({ server: { app: 'wsgi' } });
    expect(invocation('uvicorn', ['--interface', 'wsgi', 'wsgi:application'])).toMatchObject({ server: { interface: 'wsgi', app: 'wsgi:application' } });
    expect(parsePythonCommand('uvicorn', ['--interface', 'asgi2', 'a:b'])).toMatchObject({ ok: false, reason: expect.stringContaining('ASGI 2') });
  });

  it("maps a command's absolute project paths to where Python sees them", () => {
    const map = (path: string) => `/project${path}`;
    expect(mapInvocationPaths(invocation('python', ['/srv/app.py', 'x']), map)).toEqual({ kind: 'script', path: '/project/srv/app.py', argv: ['/project/srv/app.py', 'x'] });
    expect(mapInvocationPaths(invocation('pip', ['install', '-r', '/srv/req.txt', '/srv']), map)).toMatchObject({ files: ['/project/srv/req.txt'], projects: ['/project/srv'] });
    expect(mapInvocationPaths(invocation('uvicorn', ['a:b', '--app-dir', '/srv']), map)).toMatchObject({ server: { appDir: '/project/srv' } });
    expect(mapInvocationPaths(invocation('fastapi', ['run', '/srv/main.py']), map)).toMatchObject({ server: { app: 'main', appDir: '/project/srv' } });
    expect(mapInvocationPaths(invocation('python', ['rel.py']), map)).toMatchObject({ path: 'rel.py' });
  });

  it('knows which commands are Python', () => {
    for (const command of ['python', 'python3', 'python3.12', 'py', 'pip', 'pip3', 'uvicorn', 'gunicorn', 'flask', 'fastapi', 'C:\\Python\\python.exe']) expect(isPythonCommand(command)).toBe(true);
    for (const command of ['node', 'npm', 'bfsh', 'pythonista']) expect(isPythonCommand(command)).toBe(false);
  });
});

describe('requirements', () => {
  it('parses requirements.txt lines, options, markers, hashes and includes', () => {
    const { requirements, includes } = parseRequirementsTxt(
      '# deps\nFlask>=3.0  # web\nuvicorn[standard]==0.30\n-r dev.txt\n--index-url x\npg8000; python_version > "3.8"\nZope.Interface\nattrs==23.1 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\nlib --config-settings k=v\n',
    );
    expect(requirements.map((r) => r.name)).toEqual(['flask', 'uvicorn', 'pg8000', 'zope-interface', 'attrs', 'lib']);
    expect(requirements.map((r) => r.spec)).toEqual(['Flask>=3.0', 'uvicorn[standard]==0.30', 'pg8000; python_version > "3.8"', 'Zope.Interface', 'attrs==23.1', 'lib']);
    expect(includes).toEqual(['dev.txt']);
  });

  it('parses pyproject.toml arrays holding extras, comments and brackets in strings (PEP 621, then Poetry)', () => {
    const text = '[project]\nname = "x"\ndependencies = [\n  "fastapi[standard]>=0.110",  # api [web]\n  \'pg8000\',\n  "weird]name ; extra == \\"a[b]\\"",\n]\noptional = ["no"]\n[tool.x]\n';
    expect(parsePyproject(text).map((r) => r.spec)).toEqual(['fastapi[standard]>=0.110', 'pg8000', 'weird]name ; extra == "a[b]"']);
    expect(parsePyproject(text).map((r) => r.name)).toEqual(['fastapi', 'pg8000', 'weird']);
    expect(tomlStringArray('deps = ["a[x]", "b"] # c\n', 'deps')).toEqual(['a[x]', 'b']);
    expect(parsePyproject('[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3"\n').map((r) => r.name)).toEqual(['flask']);
  });

  it('reads requirements.txt with includes (each file once, however spelled), else pyproject.toml', () => {
    const files: Record<string, string> = {
      '/a/requirements.txt': 'flask\n-r more/extra.txt\n-r ./more/../more/extra.txt\n',
      '/a/more/extra.txt': 'pg8000\n-r ../requirements.txt\n',
      '/b/pyproject.toml': '[project]\ndependencies = ["starlette"]\n',
    };
    expect(readProjectRequirements((path) => files[path], '/a').map((r) => r.name)).toEqual(['flask', 'pg8000']);
    expect(readProjectRequirements((path) => files[path], '/b').map((r) => r.name)).toEqual(['starlette']);
    expect(readProjectRequirements((path) => files[path], '/c')).toEqual([]);
  });

  it('declines packages known not to work by name and leaves app servers to the runtime', () => {
    const plan = planRequirements(parseRequirementsTxt('fastapi\npsycopg2-binary==2.9\nuvicorn[standard]\npsutil\nasyncpg\nfastapi\n').requirements);
    expect(plan.install.map((r) => r.name)).toEqual(['fastapi']);
    expect(plan.provided).toEqual(['uvicorn']);
    expect(plan.declined.map((d) => d.name)).toEqual(['psycopg2-binary', 'psutil', 'asyncpg']);
    expect(plan.declined[0]!.reason).toMatch(/^"psycopg2-binary" .*pg8000/);
  });

  it('reads the packages micropip found no pure-Python wheel for', () => {
    expect(packagesWithoutWheels("ValueError: Can't find a pure Python 3 wheel for: 'grpcio', 'pyzmq'\nSee: https://pyodide.org/")).toEqual(['grpcio', 'pyzmq']);
    expect(packagesWithoutWheels('Some other failure')).toEqual([]);
  });
});

describe('extension-provided packages', () => {
  it('lets a host extension satisfy a package, ahead of the native-only list', () => {
    const plan = planRequirements(parseRequirementsTxt('torch==2.3\npeft\nfastapi\n').requirements, new Set(['torch', 'peft']));
    expect(plan).toMatchObject({ install: [{ name: 'fastapi' }], provided: ['torch', 'peft'], declined: [] });
  });
});

describe('the python provider', () => {
  const service = (over: Partial<ServiceSpec>): ServiceSpec => ({ id: 'api', type: 'application', runtime: 'python', command: 'uvicorn', args: ['main:app', '--port', '8000'], port: 8000, ...over });

  it('accepts Python commands and declines everything else with a reason', () => {
    expect(acceptsPythonService(service({}))).toEqual({ ok: true });
    expect(acceptsPythonService(service({ command: 'node', args: ['server.js'] }))).toMatchObject({ ok: false, reason: expect.stringContaining('not a Python command') });
    expect(acceptsPythonService(service({ type: 'database' }))).toMatchObject({ ok: false });
    expect(acceptsPythonService(service({ command: 'python', args: [] }))).toMatchObject({ ok: false, reason: expect.stringContaining('terminal') });
  });

  it('declines a service whose requirements (requirements.txt, or pyproject with extras) need a native-only package, naming it', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({
      'api/requirements.txt': 'fastapi\npsycopg2\n',
      'ok/requirements.txt': 'fastapi\npg8000\n',
      'proj/pyproject.toml': '[project]\ndependencies = [\n  "fastapi[standard]",\n  "psycopg[binary]>=3",\n]\n',
    });
    expect(acceptsPythonService(service({ root: '/api' }), fs)).toMatchObject({ ok: false, reason: expect.stringContaining('"psycopg2"') });
    expect(acceptsPythonService(service({ root: '/proj' }), fs)).toMatchObject({ ok: false, reason: expect.stringContaining('"psycopg"') });
    expect(acceptsPythonService(service({ root: '/ok' }), fs)).toEqual({ ok: true });
  });
});

describe('paths and headers', () => {
  it('mounts the project under /project in Python', () => {
    expect(toPyodidePath('/')).toBe('/project');
    expect(toPyodidePath('/src/app.py')).toBe('/project/src/app.py');
    expect(fromPyodidePath('/project/src/app.py')).toBe('/src/app.py');
    expect(fromPyodidePath('/project/./src/../x.py')).toBe('/x.py');
    expect(fromPyodidePath('/lib/python3.14/os.py')).toBeUndefined();
  });

  it('keeps repeated response headers (Set-Cookie)', () => {
    expect(headersOf([['Content-Type', 'text/plain'], ['set-cookie', 'a=1'], ['Set-Cookie', 'b=2']])).toEqual({ 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
  });
});
