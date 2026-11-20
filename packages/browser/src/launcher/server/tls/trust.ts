/**
 * How to make the browser trust the launcher's local CA (Node only): the command
 * that adds it to the CURRENT USER's trust store on this platform, and a cheap
 * check of whether it already is. Nothing here runs anything — the caller (the
 * VSIX after a modal approval, `bfwc-launch --trust` after a y/N prompt) does.
 *
 * - win32: `certutil -user -addstore Root <ca.cer>` (Windows asks the user to confirm).
 * - darwin: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db <ca.cer>`.
 * - linux (and anything else): no single command — the system store needs root and
 *   browsers differ (Firefox and Chromium read their own NSS stores), so the result
 *   is instructions only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CA_COMMON_NAME, derOf } from './localCa.js';

export interface TrustCommand {
  command: string;
  args: string[];
  /** The command as one line, for a prompt or a log. */
  display: string;
}

export type TrustPlan = { kind: 'command'; trust: TrustCommand } | { kind: 'manual'; instructions: string };

const quote = (arg: string) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const commandOf = (command: string, args: string[]): TrustCommand => ({ command, args, display: [command, ...args].map(quote).join(' ') });

/**
 * The trust step for the CA whose DER copy is `derPath` (`LocalCa.derPath`) and PEM is
 * `certPath`, on `platform`.
 */
export function caTrustCommand(ca: { certPath: string; derPath: string }, platform: NodeJS.Platform = process.platform, home: string = homedir()): TrustPlan {
  if (platform === 'win32') return { kind: 'command', trust: commandOf('certutil', ['-user', '-addstore', 'Root', ca.derPath]) };
  if (platform === 'darwin') {
    return { kind: 'command', trust: commandOf('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', join(home, 'Library', 'Keychains', 'login.keychain-db'), ca.derPath]) };
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
export function caTrustCheckCommand(ca: { certPem: string; derPath: string }, platform: NodeJS.Platform = process.platform): TrustCommand | null {
  if (platform === 'win32') return commandOf('certutil', ['-user', '-verifystore', 'Root', caThumbprint(ca.certPem)]);
  if (platform === 'darwin') return commandOf('security', ['verify-cert', '-c', ca.derPath]);
  return null;
}
