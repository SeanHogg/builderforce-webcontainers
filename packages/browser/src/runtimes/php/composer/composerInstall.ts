/**
 * `composer install | update | require | dump-autoload` in the PHP runtime,
 * without Composer itself: composer.phar cannot fetch here (php-wasm's network
 * is the runtime's localhost-only virtual TCP, and Packagist and GitHub
 * zipballs do not answer browsers), so the runtime does Composer's job in
 * JavaScript and writes the same results into the project — `vendor/<name>/`,
 * `vendor/autoload.php` (autoload.ts), `vendor/composer/installed.json`, and
 * `composer.lock` when it resolved one.
 *
 * - `install` with a lock: exactly the locked versions (`packages`, plus
 *   `packages-dev` unless `--no-dev`); without one: resolve, then lock.
 * - `update`: resolve afresh; `update vendor/pkg …` keeps every other locked
 *   version unless the named packages need it to move.
 * - `require vendor/name[:constraint | constraint]`: add it to composer.json
 *   (`^major.minor` of the best version when no constraint), then update it.
 * - `dump-autoload`: regenerate the autoloader from installed.json.
 *
 * Every step is checked before anything is written: names are Composer names,
 * composer.json's `repositories` are Packagist's, platform requirements are met
 * by the running PHP (a package needing an extension the image lacks is
 * declined by name, unless `--ignore-platform-reqs`). A failed `require` or
 * `update` leaves composer.json and composer.lock as they were. Scripts and
 * plugins do not run, and say so. A version already in vendor/ is not fetched
 * again.
 */
import { join } from '@seanhogg/builderforce-webcontainers-core';
import type { ComposerRequest } from '../phpCommand.js';
import { writeAutoloader, type ComposerFiles } from './autoload.js';
import { lockText, requireArguments, runtimePackages, unsupportedRepositories, type ComposerJson, type LockFile } from './lockFile.js';
import { InvalidPackageName, checkInstallableName, checkPackageName, vendorPath } from './packageName.js';
import type { PackageSource, PackageVersion } from './packagist.js';
import { isPlatformPackage, platformShortfall, type Platform } from './platform.js';
import { ResolveError, pickVersion, resolvePackages, rootRequirements } from './resolve.js';
import { parseStability, parseVersion } from './semver.js';

export interface ComposerContext {
  files: ComposerFiles;
  source: PackageSource;
  platform: Platform;
  /** composer.json's directory (a PHP path). */
  projectDir: string;
  /** md5 of the lock's content-hash input (PHP's `md5(json_encode(…))`, as Composer computes it). */
  contentHash(composerJson: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

/** A failure the user can act on, reported as Composer would (exit 2). */
class Declined extends Error {}

const SCRIPT_EVENTS = ['pre-install-cmd', 'post-install-cmd', 'pre-update-cmd', 'post-update-cmd', 'post-autoload-dump', 'post-root-package-install', 'post-create-project-cmd'];

const parseJson = <T>(text: string, path: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Declined(`${path} does not contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Platform requirements of the root and of `packages` the running PHP does not meet. */
function platformDeclines(composer: ComposerJson, packages: readonly PackageVersion[], dev: boolean, platform: Platform): string[] {
  const rootNeeds = Object.entries({ ...composer.require, ...(dev ? composer['require-dev'] : {}) }).map(([name, constraint]) => ({ name, constraint, from: 'your project' }));
  const needs = [...rootNeeds, ...packages.flatMap((pkg) => Object.entries(pkg.require ?? {}).map(([name, constraint]) => ({ name, constraint, from: pkg.name })))];
  return needs.flatMap(({ name, constraint, from }) => {
    const shortfall = isPlatformPackage(name.toLowerCase()) ? platformShortfall(name, constraint, platform) : undefined;
    return shortfall ? [`${from} requires ${name} ${constraint}: ${shortfall}`] : [];
  });
}

/** Run `request`; resolves to the exit code. */
export async function runComposer(request: ComposerRequest, context: ComposerContext): Promise<number> {
  const { files, projectDir } = context;
  const composerPath = join(projectDir, 'composer.json');
  const lockPath = join(projectDir, 'composer.lock');
  const installedPath = join(projectDir, 'vendor/composer/installed.json');
  const originalJson = files.read(composerPath);
  const originalLock = files.read(lockPath);
  const dev = !request.noDev;
  try {
    if (originalJson === undefined && request.command !== 'require') throw new Declined(`Composer could not find a composer.json file in ${projectDir}`);
    const composer = parseJson<ComposerJson>(originalJson ?? '{}', composerPath);
    const repositories = unsupportedRepositories(composer);
    if (repositories) throw new Declined(repositories);
    for (const section of ['require', 'require-dev', 'replace', 'provide', 'conflict'] as const) for (const name of Object.keys(composer[section] ?? {})) checkPackageName(name, `composer.json ${section}`);
    const installed = (): { packages: PackageVersion[]; devNames: string[] } => {
      const data = files.read(installedPath);
      if (data === undefined) return { packages: [], devNames: [] };
      const parsed = parseJson<{ packages?: PackageVersion[]; 'dev-package-names'?: string[] }>(data, installedPath);
      // Every name here may become a vendor/ path to remove: only installable package names pass.
      for (const pkg of parsed.packages ?? []) checkInstallableName(pkg.name, installedPath);
      return { packages: parsed.packages ?? [], devNames: parsed['dev-package-names'] ?? [] };
    };

    // Read (and validated) before anything is written: its names become vendor/ paths to remove.
    const current = installed();
    if (request.command === 'dump-autoload') {
      const { packages, devNames } = current;
      const devPackages = new Set(devNames);
      writeAutoloader(files, projectDir, composer, dev ? packages : packages.filter((pkg) => !devPackages.has(pkg.name)), { dev, devPackages: dev ? devPackages : new Set() });
      context.out('Generating autoload files\nGenerated autoload files\n');
      return 0;
    }
    const options = { minimumStability: parseStability(composer['minimum-stability']), preferStable: !!composer['prefer-stable'] };

    if (request.command === 'require') {
      const section = request.dev ? 'require-dev' : 'require';
      for (const { name, constraint: written } of requireArguments(request.packages)) {
        let constraint = written;
        if (!constraint) {
          // The newest release the running PHP can run (unless platform requirements are ignored).
          const all = await context.source.versions(name);
          const versions = all?.filter((pkg) => request.ignorePlatformReqs || !platformDeclines({}, [pkg], false, context.platform).length);
          const best = versions && pickVersion(versions, [], options);
          const newest = !best && all && pickVersion(all, [], options);
          // Every release needs what the running PHP lacks: say what, by name.
          if (newest) throw new ResolveError(`${newest.name} ${newest.version} is declined: ${platformDeclines({}, [newest], false, context.platform).join('; ')}`);
          const parsed = best && parseVersion(best.version_normalized ?? best.version);
          if (!parsed || parsed.branch) throw new ResolveError(`Could not find a stable version of package ${name}.`);
          constraint = `^${parsed.parts[0]}.${parsed.parts[1]}`;
        }
        composer[section] = { ...composer[section], [name]: constraint };
        context.err(`./composer.json has been updated (${name}: ${constraint})\n`);
      }
    }
    const json = `${JSON.stringify(composer, null, 4)}\n`;

    let lock: LockFile | undefined = request.command === 'install' && originalLock !== undefined ? parseJson<LockFile>(originalLock, lockPath) : undefined;
    let writeLock = false;
    if (lock) {
      context.err('Installing dependencies from lock file' + (dev ? ' (including require-dev)' : '') + '\n');
      for (const pkg of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) checkInstallableName(pkg.name, lockPath);
      if (lock['content-hash'] && lock['content-hash'] !== (await context.contentHash(originalJson ?? json))) context.err('Warning: The lock file is not up to date with the latest changes in composer.json. Run `composer update`.\n');
    } else {
      context.err(request.command === 'install' ? 'No composer.lock file present. Updating dependencies to latest instead of installing from lock file.\n' : 'Updating dependencies\n');
      // `update a/b` (and `require a/b`): every other package keeps its locked version unless it has to move.
      const partial = request.command === 'require' ? requireArguments(request.packages).map((entry) => entry.name) : request.packages.map((name) => checkPackageName(name, 'composer update'));
      const previous = partial.length && originalLock !== undefined ? parseJson<LockFile>(originalLock, lockPath) : undefined;
      const preferred = new Map([...(previous?.packages ?? []), ...(previous?.['packages-dev'] ?? [])].filter((pkg) => !partial.includes(pkg.name)).map((pkg) => [pkg.name, pkg.version]));
      const resolution = await resolvePackages(rootRequirements(composer, false), context.source, { ...options, preferred, platform: request.ignorePlatformReqs ? undefined : context.platform }, composer);
      for (const pkg of resolution.packages.values()) context.err(`  - Locking ${pkg.name} (${pkg.version})\n`);
      const runtime = runtimePackages(composer, resolution.packages);
      const sorted = [...resolution.packages.values()].sort((a, b) => a.name.localeCompare(b.name));
      lock = { 'content-hash': await context.contentHash(json), packages: sorted.filter((pkg) => runtime.has(pkg.name)), 'packages-dev': sorted.filter((pkg) => !runtime.has(pkg.name)) };
      writeLock = true;
    }

    const wanted = [...(lock.packages ?? []), ...(dev ? (lock['packages-dev'] ?? []) : [])];
    const devPackages = new Set(dev ? (lock['packages-dev'] ?? []).map((pkg) => pkg.name) : []);
    const declined = request.ignorePlatformReqs ? [] : platformDeclines(composer, wanted, dev, context.platform);
    if (declined.length) throw new Declined(`Your requirements could not be resolved to an installable set of packages.\n${declined.map((line) => `  - Declined: ${line}`).join('\n')}`);

    // Checked: now write composer.json and the lock, then vendor/.
    if (request.command === 'require') files.write(composerPath, json);
    if (writeLock) {
      files.write(lockPath, lockText(lock, options));
      context.err('Writing lock file\n');
    }
    const before = new Map(current.packages.map((pkg) => [pkg.name, pkg]));
    // Installed means recorded AND on disk: a vendor/ directory removed by hand (or never written) is installed again.
    const sameVersion = (a: PackageVersion | undefined, b: PackageVersion) =>
      !!a && a.version === b.version && (a.dist?.reference ?? null) === (b.dist?.reference ?? null) && files.isDir(vendorPath(projectDir, b.name));
    const changes = wanted.filter((pkg) => !sameVersion(before.get(pkg.name), pkg));
    const removals = [...before.keys()].filter((name) => !wanted.some((pkg) => pkg.name === name));
    context.err(`Package operations: ${changes.length} install${changes.length === 1 ? '' : 's'}, 0 updates, ${removals.length} removal${removals.length === 1 ? '' : 's'}\n`);
    // Every package's files are fetched before vendor/ is touched: a fetch that fails leaves vendor/ and installed.json as they were.
    const fetched: Array<[PackageVersion, Map<string, Uint8Array>]> = [];
    for (const pkg of changes) {
      context.err(`  - Downloading ${pkg.name} (${pkg.version})\n`);
      const contents = await context.source.files(pkg);
      for (const path of contents.keys()) if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) throw new Declined(`${pkg.name} ${pkg.version} holds a file outside its directory ("${path}").`);
      fetched.push([pkg, contents]);
    }
    for (const name of removals) {
      files.remove(vendorPath(projectDir, name));
      context.err(`  - Removing ${name}\n`);
    }
    for (const [pkg, contents] of fetched) {
      const target = vendorPath(projectDir, pkg.name);
      context.err(`  - Installing ${pkg.name} (${pkg.version})\n`);
      files.remove(target);
      for (const [path, bytes] of contents) files.write(join(target, path), bytes);
      if (pkg.type === 'composer-plugin') context.err(`    ${pkg.name} is a Composer plugin; plugins do not run in the PHP runtime.\n`);
    }
    if (!changes.length && !removals.length) context.err('Nothing to install, update or remove\n');
    context.err('Generating autoload files\n');
    writeAutoloader(files, projectDir, composer, wanted, { dev, devPackages });
    const hooks = SCRIPT_EVENTS.filter((event) => composer.scripts?.[event] !== undefined);
    if (hooks.length) context.err(`Composer scripts do not run in the PHP runtime (${hooks.join(', ')}); run their commands yourself if needed.\n`);
    return 0;
  } catch (error) {
    // A failed require/update leaves composer.json and composer.lock as they were.
    if (request.command === 'require' || request.command === 'update') {
      if (originalJson === undefined) files.remove(composerPath);
      else if (files.read(composerPath) !== originalJson) files.write(composerPath, originalJson);
      if (originalLock === undefined) files.remove(lockPath);
      else if (files.read(lockPath) !== originalLock) files.write(lockPath, originalLock);
    }
    const known = error instanceof ResolveError || error instanceof Declined || error instanceof InvalidPackageName;
    const lead = error instanceof ResolveError ? 'Your requirements could not be resolved to an installable set of packages.\n  ' : '';
    context.err(`${lead}${error instanceof Error ? error.message : String(error)}\n`);
    return known ? 2 : 1;
  }
}
