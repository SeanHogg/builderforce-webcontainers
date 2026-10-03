/**
 * `npm` and `npx`, in-process in the shell. Installs go through the core
 * installer (installer/); scripts run through a child shell with npm's
 * environment (`node_modules/.bin` on PATH, `npm_lifecycle_event`, …) and
 * pre/post hooks. `npx` runs an installed bin, or installs the package into a
 * scratch directory first, as npx does.
 */
import { join } from '../paths.js';
import { installPackages, type InstallOptions } from '../installer/install.js';
import type { PackageJson } from '../installer/spec.js';
import { binDirectories, findExecutable } from '../system/commands.js';
import { findPackageScope } from '../node/resolve.js';
import { parseFlags, type CommandContext } from './context.js';
import type { JobInput, Shell } from './exec.js';
import { matchDevServer } from './devHandoff.js';

export const NPM_VERSION = '10.8.2';

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

function projectDir(ctx: CommandContext): string {
  return findPackageScope(ctx.fs, ctx.cwd)?.dir ?? ctx.cwd;
}

function readPackage(ctx: CommandContext, dir: string): PackageJson | undefined {
  try {
    return JSON.parse(ctx.fs.readText(join(dir, 'package.json')) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

async function install(ctx: CommandContext, options: Partial<InstallOptions>, dir = projectDir(ctx)): Promise<number> {
  const started = performance.now();
  const progress = ctx.io.isTerminal;
  try {
    const result = await installPackages({
      fs: ctx.fs,
      fetch: (url, init) => ctx.system.fetch(url, init as RequestInit),
      registry: ctx.env.npm_config_registry ?? ctx.system.registry,
      cache: ctx.system.packageCache,
      cwd: dir,
      signal: ctx.signal,
      onProgress: progress ? (p) => p.phase === 'fetch' && ctx.io.stdout(`\r\x1b[Kfetching ${p.done}/${p.total} ${p.package ?? ''}`) : undefined,
      ...options,
    });
    if (progress) ctx.io.stdout('\r\x1b[K');
    for (const warning of result.warnings) ctx.io.stderr(`npm warn ${warning}\n`);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const parts = [result.added && `added ${result.added} package${result.added === 1 ? '' : 's'}`, result.removed && `removed ${result.removed} package${result.removed === 1 ? '' : 's'}`].filter(Boolean);
    ctx.io.stdout(`\n${parts.length ? parts.join(', ') : 'up to date'}, audited ${result.total + 1} packages in ${seconds}s\n`);
    return 0;
  } catch (error) {
    if (progress) ctx.io.stdout('\r\x1b[K');
    if (ctx.signal.aborted) return 130;
    ctx.io.stderr(`npm error ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runScript(ctx: CommandContext, shell: Shell, input: JobInput, name: string, extra: string[]): Promise<number> {
  const dir = projectDir(ctx);
  const pkg = readPackage(ctx, dir);
  if (!pkg) {
    ctx.io.stderr(`npm error Could not read package.json in ${dir}\n`);
    return 1;
  }
  const scripts = { ...pkg.scripts };
  if (name === 'start' && !scripts.start && ctx.fs.isFile(join(dir, 'server.js'))) scripts.start = 'node server.js';
  if (!scripts[name]) {
    if (name === 'test') {
      ctx.io.stderr('npm error Missing script: "test"\n');
      return 1;
    }
    ctx.io.stderr(`npm error Missing script: "${name}"\n\nTo see a list of scripts, run:\n  npm run\n`);
    return 1;
  }
  const PATH = [...binDirectories(dir), ctx.env.PATH ?? ''].filter(Boolean).join(':');
  for (const stage of [`pre${name}`, name, `post${name}`]) {
    const script = scripts[stage];
    if (!script) continue;
    const command = stage === name && extra.length ? `${script} ${extra.map(quote).join(' ')}` : script;
    ctx.io.stdout(`\n> ${pkg.name ?? ''}${pkg.version ? '@' + pkg.version : ''} ${stage}\n> ${command}\n\n`);
    const child = shell.fork({
      cwd: dir,
      env: {
        PATH,
        npm_lifecycle_event: stage,
        npm_lifecycle_script: script,
        npm_command: 'run-script',
        npm_package_name: pkg.name ?? '',
        npm_package_version: pkg.version ?? '',
        npm_package_json: join(dir, 'package.json'),
        INIT_CWD: ctx.cwd,
        NODE: '/usr/local/bin/node',
      },
    });
    const status = await child.exec(command, { stdout: ctx.io.stdout, stderr: ctx.io.stderr, isTerminal: ctx.io.isTerminal }, input, ctx.signal);
    if (status !== 0) {
      if (!ctx.signal.aborted) ctx.io.stderr(`npm error Lifecycle script \`${stage}\` failed with error:\nnpm error code ${status}\n`);
      return status;
    }
  }
  return 0;
}

function listScripts(ctx: CommandContext): number {
  const pkg = readPackage(ctx, projectDir(ctx));
  const scripts = Object.entries(pkg?.scripts ?? {});
  if (!scripts.length) return 0;
  ctx.io.stdout(`Scripts available in ${pkg?.name ?? 'this package'} via \`npm run-script\`:\n${scripts.map(([k, v]) => `  ${k}\n    ${v}`).join('\n')}\n`);
  return 0;
}

export async function npmCommand(ctx: CommandContext, shell: Shell, input: JobInput): Promise<number> {
  const [sub = 'help', ...rest] = ctx.args;
  const { flags, operands } = parseFlags(rest, ['registry']);
  const dev = flags.has('D') || flags.has('save-dev');
  const production = flags.has('production') || rest.includes('--omit=dev');
  switch (sub) {
    case '-v':
    case '--version':
    case 'version':
      ctx.io.stdout(`${NPM_VERSION}\n`);
      return 0;
    case 'install':
    case 'i':
    case 'add':
    case 'isntall':
      return install(ctx, { add: operands, saveDev: dev, production });
    case 'ci':
    case 'clean-install':
      return install(ctx, { ci: true, production });
    case 'uninstall':
    case 'remove':
    case 'rm':
    case 'un': {
      const dir = projectDir(ctx);
      const pkg = readPackage(ctx, dir);
      if (!pkg) {
        ctx.io.stderr('npm error No package.json found\n');
        return 1;
      }
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        for (const name of operands) if (pkg[field]) delete pkg[field]![name];
      }
      ctx.fs.writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      return install(ctx, {}, dir);
    }
    case 'run':
    case 'run-script': {
      const dash = rest.indexOf('--');
      const [name, ...args] = dash >= 0 ? [...rest.slice(0, dash), ...rest.slice(dash + 1)] : rest;
      return name ? runScript(ctx, shell, input, name, args) : listScripts(ctx);
    }
    case 'start':
    case 'test':
    case 't':
    case 'stop':
    case 'restart':
      return runScript(ctx, shell, input, sub === 't' ? 'test' : sub, rest.filter((a) => a !== '--'));
    case 'init': {
      const path = join(ctx.cwd, 'package.json');
      if (ctx.fs.isFile(path)) {
        ctx.io.stderr('npm error package.json already exists\n');
        return 1;
      }
      const name = ctx.cwd.split('/').filter(Boolean).pop() ?? 'project';
      const pkg = { name, version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };
      ctx.fs.writeFile(path, JSON.stringify(pkg, null, 2) + '\n');
      ctx.io.stdout(`Wrote to ${path}:\n\n${JSON.stringify(pkg, null, 2)}\n`);
      return 0;
    }
    case 'ls':
    case 'list': {
      const dir = projectDir(ctx);
      const pkg = readPackage(ctx, dir);
      const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
      ctx.io.stdout(`${pkg?.name ?? ''}@${pkg?.version ?? ''} ${dir}\n`);
      const names = Object.keys(deps).sort();
      names.forEach((name, i) => {
        const installed = readPackage(ctx, join(dir, 'node_modules', name))?.version;
        ctx.io.stdout(`${i === names.length - 1 ? '└──' : '├──'} ${name}@${installed ?? `(missing ${deps[name]})`}\n`);
      });
      return 0;
    }
    case 'exec':
    case 'x':
      return npxCommand({ ...ctx, args: rest.filter((a) => a !== '--') }, shell, input);
    case 'help':
    case '-h':
    case '--help':
      ctx.io.stdout(`npm ${NPM_VERSION} (BuilderForce WebContainers)\n\nUsage: npm <install|ci|uninstall|run|start|test|init|ls|exec> …\n`);
      return 0;
    default:
      ctx.io.stderr(`npm error Unknown command: "${sub}"\n`);
      return 1;
  }
}

export async function npxCommand(ctx: CommandContext, shell: Shell, input: JobInput): Promise<number> {
  const args = ctx.args.filter((a) => a !== '-y' && a !== '--yes');
  const packageFlag = args.findIndex((a) => a === '-p' || a === '--package');
  const explicitPackage = packageFlag >= 0 ? args.splice(packageFlag, 2)[1] : undefined;
  const [bin, ...rest] = args;
  if (!bin) {
    ctx.io.stderr('npx: missing command\n');
    return 1;
  }
  const binName = bin.replace(/^@[^/]+\//, '').replace(/@[^@]*$/, '');
  const io = { stdout: ctx.io.stdout, stderr: ctx.io.stderr, isTerminal: ctx.io.isTerminal };
  if (matchDevServer([binName, ...rest])) return shell.fork({}).exec([binName, ...rest].map(quote).join(' '), io, input, ctx.signal);
  let found = findExecutable(ctx.fs, binName, ctx.cwd, { PATH: '' });
  if (!found) {
    // Not installed locally: install into a scratch project, as npx does.
    const spec = explicitPackage ?? bin;
    const scratch = `/tmp/.npx/${spec.replace(/[^\w.-]+/g, '_')}`;
    if (!ctx.fs.isFile(join(scratch, 'package.json'))) ctx.fs.writeFile(join(scratch, 'package.json'), '{"private": true}\n');
    ctx.io.stderr(`npx: installing ${spec}\n`);
    const status = await install({ ...ctx, io: { ...ctx.io, stdout: () => undefined } }, { add: [spec] }, scratch);
    if (status !== 0) return status;
    found = findExecutable(ctx.fs, binName, scratch, { PATH: '' }) ?? findExecutable(ctx.fs, ctx.fs.readdir(join(scratch, 'node_modules/.bin'))[0] ?? binName, scratch, { PATH: '' });
    if (!found) {
      ctx.io.stderr(`npx: ${spec} has no executable named ${binName}\n`);
      return 1;
    }
  }
  return shell.fork({}).exec([found, ...rest].map(quote).join(' '), io, input, ctx.signal);
}
