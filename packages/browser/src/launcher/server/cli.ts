#!/usr/bin/env node
/**
 * `bfwc-launch [dir] [--env name] [--port n] [--trust] [--ca-dir path]`: start the
 * local launcher for a project directory (default: the current one) and print the
 * https URL to open. Runs until interrupted.
 *
 * The launcher's certificates come from the user's local CA (`--ca-dir`, default
 * `~/.builderforce/launcher-ca`). Until the browser trusts it, it warns: `--trust`
 * shows the platform's trust command and runs it only after an interactive y/N;
 * without `--trust` the command is printed, never run.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createLocalLauncher, defaultCaStoreDir } from './launcher.js';
import { caTrustCommand, type TrustCommand } from './tls/trust.js';

const USAGE = 'Usage: bfwc-launch [dir] [--env name] [--port n] [--trust] [--ca-dir path]';

interface CliArgs {
  dir: string;
  environment?: string;
  port?: number;
  trust: boolean;
  caDir?: string;
}

function parseCliArgs(argv: readonly string[]): CliArgs | string {
  const args: CliArgs = { dir: '.', trust: false };
  let dirSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return USAGE;
    if (arg === '--trust') {
      args.trust = true;
    } else if (arg === '--env' || arg === '--port' || arg === '--ca-dir') {
      const value = argv[++i];
      if (value === undefined) return `${arg} needs a value.\n${USAGE}`;
      if (arg === '--env') args.environment = value;
      else if (arg === '--ca-dir') args.caDir = value;
      else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) return `--port must be 0–65535.\n${USAGE}`;
        args.port = port;
      }
    } else if (arg.startsWith('-') || dirSeen) {
      return `Unexpected argument "${arg}".\n${USAGE}`;
    } else {
      args.dir = arg;
      dirSeen = true;
    }
  }
  return args;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // never without a person to answer
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

function run(command: TrustCommand): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command.command, command.args, { stdio: 'inherit', shell: false });
    child.on('error', (error) => {
      console.error(`bfwc-launch: ${error.message}`);
      done(1);
    });
    child.on('exit', (code) => done(code ?? 1));
  });
}

async function offerTrust(ca: { certPath: string; derPath: string }, trust: boolean): Promise<void> {
  const plan = caTrustCommand(ca);
  if (plan.kind === 'manual') {
    console.log(`The browser warns until it trusts the launcher's local CA.\n${plan.instructions}`);
    return;
  }
  if (!trust) {
    console.log(`The browser warns until it trusts the launcher's local CA. To trust it (current user only), run:\n  ${plan.trust.display}\nor start with --trust.`);
    return;
  }
  console.log(`To trust the launcher's local CA (it can only certify localhost, *.localhost and 127.0.0.1), this runs:\n  ${plan.trust.display}`);
  if (!(await confirm('Run it now?'))) {
    console.log('Not trusted: the browser will warn until it is.');
    return;
  }
  const code = await run(plan.trust);
  console.log(code === 0 ? 'Trusted.' : `The trust command exited with ${code}.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(args);
    process.exitCode = args === USAGE ? 0 : 2;
    return;
  }
  const launcher = await createLocalLauncher({
    projectDir: resolve(args.dir),
    environment: args.environment,
    port: args.port,
    tls: { storeDir: args.caDir ? resolve(args.caDir) : defaultCaStoreDir() },
  });
  if (launcher.ca) await offerTrust(launcher.ca, args.trust);
  console.log(launcher.url);
  const stop = () => void launcher.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(`bfwc-launch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
