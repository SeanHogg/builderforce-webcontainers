/**
 * How to make the browser trust the launcher's local CA (Node only): the command
 * that adds it to the CURRENT USER's trust store on this platform, and a cheap
 * check of whether it already is. Nothing here runs anything — the caller (the
 * VSIX after a modal approval, `bfwc-launch --trust` after a y/N prompt) does.
 *
 * - win32: `%SystemRoot%\System32\certutil.exe -user -addstore Root <ca.cer>` (Windows asks the user to confirm).
 * - darwin: `/usr/bin/security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db <ca.cer>`.
 * - linux (and anything else): no single command — the system store needs root and
 *   browsers differ (Firefox and Chromium read their own NSS stores), so the result
 *   is instructions only.
 *
 * Every command names its tool by ABSOLUTE path (`certutil.exe` under the system
 * root's System32, `/usr/bin/security`) and carries `cwd`: the CA store directory.
 * A bare `certutil` is resolved by the Windows search order, which looks in the
 * current directory first — a project shipping its own `certutil.exe` would run
 * when the user approves trust. The caller spawns `command` with `args` and `cwd`,
 * never through a shell.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { CA_COMMON_NAME, derOf } from './localCa.js';

export interface TrustCommand {
  /** The tool, as an absolute path. */
  command: string;
  args: string[];
  /** The directory to run it in: the CA store's (never the project's). */
  cwd: string;
  /** The command as one line, for a prompt or a log. */
  display: string;
}

export type TrustPlan = { kind: 'command'; trust: TrustCommand } | { kind: 'manual'; instructions: string };

const quote = (arg: string) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const commandOf = (command: string, args: string[], cwd: string): TrustCommand => ({ command, args, cwd, display: [command, ...args].map(quote).join(' ') });

/** macOS's `security` tool. */
export const DARWIN_SECURITY = '/usr/bin/security';
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

/**
 * Windows' `certutil.exe`, by absolute path: `%SystemRoot%\System32\certutil.exe` when
 * SystemRoot is a drive-absolute path (`C:\…`), else under `C:\Windows`. A relative,
 * drive-relative or UNC SystemRoot is ignored: it could point into the project or a share.
 */
export function windowsCertutil(systemRoot: string | undefined = process.env.SystemRoot): string {
  const root = systemRoot !== undefined && /^[A-Za-z]:[\\/]/.test(systemRoot) && !systemRoot.split(/[\\/]/).includes('..') ? systemRoot : DEFAULT_SYSTEM_ROOT;
  return win32.join(root, 'System32', 'certutil.exe');
}

/**
 * The trust step for the CA whose DER copy is `derPath` (`LocalCa.derPath`) and PEM is
 * `certPath`, on `platform`.
 */
export function caTrustCommand(
  ca: { certPath: string; derPath: string },
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  systemRoot: string | undefined = process.env.SystemRoot,
): TrustPlan {
  const cwd = dirname(ca.derPath);
  if (platform === 'win32') return { kind: 'command', trust: commandOf(windowsCertutil(systemRoot), ['-user', '-addstore', 'Root', ca.derPath], cwd) };
  if (platform === 'darwin') {
    return { kind: 'command', trust: commandOf(DARWIN_SECURITY, ['add-trusted-cert', '-r', 'trustRoot', '-k', join(home, 'Library', 'Keychains', 'login.keychain-db'), ca.derPath], cwd) };
  }
  return {
    kind: 'manual',
    instructions: [
      `Trust "${CA_COMMON_NAME}" (${ca.certPath}):`,
      `  Chromium/Chrome (NSS): certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "${CA_COMMON_NAME}" -i ${quote(ca.certPath)}`,
      `  System store (needs root): sudo cp ${quote(ca.certPath)} /usr/local/share/ca-certificates/builderforce-launcher-ca.crt && sudo update-ca-certificates`,
      '  Firefox: Settings › Privacy & Security › Certificates › View Certificates › Authorities › Import, then trust it for websites.',
    ].join('\n'),
  };
}

/** The certificate's SHA-1 thumbprint (uppercase hex), as Windows names it. */
export function caThumbprint(certPem: string): string {
  return createHash('sha1').update(derOf(certPem)).digest('hex').toUpperCase();
}

/**
 * A command whose exit code 0 means the CA is already trusted, where that is cheap to
 * ask; null (unknown) elsewhere. win32: `certutil -user -verifystore Root <thumbprint>`;
 * darwin: `security verify-cert -c <ca.cer>`.
 */
export function caTrustCheckCommand(
  ca: { certPem: string; derPath: string },
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SystemRoot,
): TrustCommand | null {
  const cwd = dirname(ca.derPath);
  if (platform === 'win32') return commandOf(windowsCertutil(systemRoot), ['-user', '-verifystore', 'Root', caThumbprint(ca.certPem)], cwd);
  if (platform === 'darwin') return commandOf(DARWIN_SECURITY, ['verify-cert', '-c', ca.derPath], cwd);
  return null;
}
