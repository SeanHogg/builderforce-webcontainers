/**
 * The launcher's local CA and certificates (`launcher/server/tls/`): the CA's flags
 * and name constraints, per-host leaves, SNI issuing distinct certificates and
 * refusing names off the allowlist, CA reuse across restarts and regeneration when
 * corrupt, and the per-platform trust commands (never run here).
 */
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SecureContext } from 'node:tls';
import forge from 'node-forge';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyHostname } from '../../src/launcher/server/hosts.js';
import { createLeafCache, issueLeaf, LEAF_VALIDITY_DAYS } from '../../src/launcher/server/tls/issueCert.js';
import { CA_COMMON_NAME, CA_FILES, caProblem, loadOrCreateLocalCa, loopbackNameConstraints, newRsaKeys, randomSerial, type LocalCa } from '../../src/launcher/server/tls/localCa.js';
import { createSniCallback } from '../../src/launcher/server/tls/sni.js';
import { caThumbprint, caTrustCheckCommand, caTrustCommand, windowsCertutil } from '../../src/launcher/server/tls/trust.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bfwc-ca-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const KEY = '0123456789abcdef0123456789abcdef';
let shared: LocalCa | undefined;
const sharedCa = async () => (shared ??= await loadOrCreateLocalCa(tempDir()));

describe('the local CA', () => {
  it('is a pathLen-0 CA for certificate and CRL signing only, constrained to localhost, *.localhost and 127.0.0.1', async () => {
    const ca = await sharedCa();
    const x509 = new X509Certificate(ca.certPem);
    expect(x509.ca).toBe(true);
    expect(x509.subject).toBe(`CN=${CA_COMMON_NAME}`);
    expect(x509.checkIssued(x509)).toBe(true); // self-signed
    const days = (Date.parse(x509.validTo) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(5 * 365 - 2);

    const cert = forge.pki.certificateFromPem(ca.certPem);
    expect(cert.getExtension('basicConstraints')).toMatchObject({ critical: true, cA: true, pathLenConstraint: 0 });
    expect(cert.getExtension('keyUsage')).toMatchObject({ critical: true, keyCertSign: true, cRLSign: true, digitalSignature: false });
    const constraints = cert.getExtension('nameConstraints') as { critical: boolean; permittedSubtrees: { type: number; value: string }[]; excludedSubtrees: unknown[] };
    expect(constraints.critical).toBe(true);
    expect(constraints.permittedSubtrees).toEqual([
      { type: 2, value: 'localhost' },
      { type: 2, value: '.localhost' },
      { type: 7, value: String.fromCharCode(127, 0, 0, 1, 255, 255, 255, 255) },
    ]);
    expect(constraints.excludedSubtrees).toEqual([]);
  });

  it('is reused across restarts from its store, and regenerated when corrupt or when the key does not match', async () => {
    const dir = tempDir();
    const first = await loadOrCreateLocalCa(dir);
    expect(first.certPath).toBe(join(dir, CA_FILES.cert));
    expect(new X509Certificate(readFileSync(first.derPath)).fingerprint256).toBe(new X509Certificate(first.certPem).fingerprint256);
    const again = await loadOrCreateLocalCa(dir);
    expect(again.certPem).toBe(first.certPem);
    expect(again.keyPem).toBe(first.keyPem);

    writeFileSync(join(dir, CA_FILES.cert), '-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n');
    const regenerated = await loadOrCreateLocalCa(dir);
    expect(regenerated.certPem).not.toBe(first.certPem);
    expect(new X509Certificate(regenerated.certPem).ca).toBe(true);

    const other = await loadOrCreateLocalCa(tempDir());
    writeFileSync(join(dir, CA_FILES.key), other.keyPem); // a key that is not this certificate's
    const rekeyed = await loadOrCreateLocalCa(dir);
    expect(rekeyed.certPem).not.toBe(regenerated.certPem);
  });

  /** A planted "launcher CA": the right name, its own key, and the given extensions; signed by `signer` (default: itself). */
  const plantedCa = (extensions: object[], signer?: forge.pki.rsa.PrivateKey) => {
    const keys = newRsaKeys();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 3_600_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    cert.setSubject([{ name: 'commonName', value: CA_COMMON_NAME }]);
    cert.setIssuer([{ name: 'commonName', value: CA_COMMON_NAME }]);
    cert.setExtensions(extensions.map((extension) => ({ ...extension }))); // forge writes the encoded `value` onto each object it is given
    cert.sign(signer ?? keys.privateKey, forge.md.sha256.create());
    return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.keyPem };
  };
  const BASIC = { name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 };
  const USAGE = { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true };
  const CONSTRAINTS = { id: '2.5.29.30', name: 'nameConstraints', critical: true, value: loopbackNameConstraints() };
  const otherConstraints = () => {
    const { Class, Type } = forge.asn1;
    const dns = forge.asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [forge.asn1.create(Class.CONTEXT_SPECIFIC, 2, false, 'example.com')]);
    return forge.asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [forge.asn1.create(Class.CONTEXT_SPECIFIC, 0, true, [dns])]);
  };

  it('accepts exactly what it writes, and nothing looser (N2)', () => {
    const exact = plantedCa([BASIC, USAGE, CONSTRAINTS]);
    expect(caProblem(exact.certPem, exact.keyPem)).toBeNull();
    const cases: [string, ReturnType<typeof plantedCa>, RegExp][] = [
      ['unconstrained', plantedCa([BASIC, USAGE]), /no name constraints/],
      ['non-critical constraints', plantedCa([BASIC, USAGE, { ...CONSTRAINTS, critical: false }]), /not critical/],
      ['other constraints', plantedCa([BASIC, USAGE, { ...CONSTRAINTS, value: otherConstraints() }]), /not the loopback ones/],
      ['duplicate constraints', plantedCa([BASIC, USAGE, CONSTRAINTS, CONSTRAINTS]), /no name constraints/],
      ['pathLen missing', plantedCa([{ name: 'basicConstraints', critical: true, cA: true }, USAGE, CONSTRAINTS]), /pathLen-0/],
      ['pathLen 1', plantedCa([{ ...BASIC, pathLenConstraint: 1 }, USAGE, CONSTRAINTS]), /pathLen-0/],
      ['non-critical basicConstraints', plantedCa([{ ...BASIC, critical: false }, USAGE, CONSTRAINTS]), /pathLen-0/],
      ['not a CA', plantedCa([{ name: 'basicConstraints', critical: true, cA: false }, USAGE, CONSTRAINTS]), /pathLen-0/],
      ['extra key usage', plantedCa([BASIC, { ...USAGE, digitalSignature: true }, CONSTRAINTS]), /key usage/],
      ['non-critical key usage', plantedCa([BASIC, { ...USAGE, critical: false }, CONSTRAINTS]), /key usage/],
      ['no key usage', plantedCa([BASIC, CONSTRAINTS]), /key usage/],
      ['not self-signed', plantedCa([BASIC, USAGE, CONSTRAINTS], newRsaKeys().privateKey), /not self-signed/],
    ];
    for (const [label, planted, problem] of cases) expect(caProblem(planted.certPem, planted.keyPem) ?? 'accepted', label).toMatch(problem);
  });

  it('replaces a planted unconstrained, non-critical-constraint, pathLen-missing or not-self-signed CA in its store (N2)', async () => {
    const planted = [
      plantedCa([BASIC, USAGE]),
      plantedCa([BASIC, USAGE, { ...CONSTRAINTS, critical: false }]),
      plantedCa([{ name: 'basicConstraints', critical: true, cA: true }, USAGE, CONSTRAINTS]),
      plantedCa([BASIC, USAGE, CONSTRAINTS], newRsaKeys().privateKey),
    ];
    for (const { certPem, keyPem } of planted) {
      const dir = tempDir();
      writeFileSync(join(dir, CA_FILES.cert), certPem);
      writeFileSync(join(dir, CA_FILES.key), keyPem);
      const loaded = await loadOrCreateLocalCa(dir);
      expect(loaded.certPem).not.toBe(certPem);
      expect(loaded.keyPem).not.toBe(keyPem);
      expect(caProblem(loaded.certPem, loaded.keyPem)).toBeNull();
      expect(readFileSync(join(dir, CA_FILES.cert), 'utf8')).toBe(loaded.certPem);
      expect(new X509Certificate(readFileSync(loaded.derPath)).fingerprint256).toBe(new X509Certificate(loaded.certPem).fingerprint256);
    }
  });

  it('serials are positive and minimally encoded: the first byte is 0x40–0x7f (N3)', async () => {
    for (let i = 0; i < 2000; i++) {
      const first = Number.parseInt(randomSerial().slice(0, 2), 16);
      expect(first).toBeGreaterThanOrEqual(0x40);
      expect(first).toBeLessThanOrEqual(0x7f);
    }
    const ca = await sharedCa();
    for (const pem of [ca.certPem, issueLeaf(ca, 'localhost').certPem]) {
      const serial = new X509Certificate(pem).serialNumber;
      expect(serial).toHaveLength(32); // 16 bytes: no leading zero stripped, no sign byte added
      expect(Number.parseInt(serial.slice(0, 2), 16)).toBeGreaterThanOrEqual(0x40);
    }
  });

  it('writes its files through a temp file + rename, leaving nothing else in the store (N5)', async () => {
    const dir = tempDir();
    await loadOrCreateLocalCa(dir);
    expect(readdirSync(dir).sort()).toEqual([CA_FILES.der, CA_FILES.key, CA_FILES.cert].sort());
    writeFileSync(join(dir, CA_FILES.cert), 'corrupt'); // regenerated over existing files
    await loadOrCreateLocalCa(dir);
    expect(readdirSync(dir).sort()).toEqual([CA_FILES.der, CA_FILES.key, CA_FILES.cert].sort());
  });

  it.skipIf(process.platform === 'win32')('keeps the key 0600 and re-applies 0700 to a store directory that already existed (N5)', async () => {
    const dir = join(tempDir(), 'store');
    mkdirSync(dir, { mode: 0o755 });
    const ca = await loadOrCreateLocalCa(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, CA_FILES.key)).mode & 0o777).toBe(0o600);
    expect(statSync(ca.certPath).mode & 0o077).toBe(0);
  });

  it('is regenerated when it expires within 30 days', async () => {
    const dir = tempDir();
    const now = new Date();
    const first = await loadOrCreateLocalCa(dir, now);
    const nearExpiry = new Date(now.getTime() + (5 * 365 - 10) * 86_400_000);
    const renewed = await loadOrCreateLocalCa(dir, nearExpiry);
    expect(renewed.certPem).not.toBe(first.certPem);
  });
});

describe('leaf certificates', () => {
  it('name exactly their host (SAN DNS, or SAN IP for 127.0.0.1), for serverAuth, within 397 days, issued by the CA', async () => {
    const ca = await sharedCa();
    const caCert = new X509Certificate(ca.certPem);
    for (const host of ['localhost', `${KEY}.localhost`]) {
      const leaf = new X509Certificate(issueLeaf(ca, host).certPem);
      expect(leaf.subjectAltName).toBe(`DNS:${host}`);
      expect(leaf.checkHost(host)).toBe(host);
      expect(leaf.checkHost('example.com')).toBeUndefined();
      expect(leaf.ca).toBe(false);
      expect(leaf.checkIssued(caCert)).toBe(true);
      expect(leaf.verify(caCert.publicKey)).toBe(true);
      expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1'); // serverAuth
      expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBeLessThanOrEqual(LEAF_VALIDITY_DAYS * 86_400_000);
    }
    const ip = new X509Certificate(issueLeaf(ca, '127.0.0.1').certPem);
    expect(ip.subjectAltName).toBe('IP Address:127.0.0.1');
    expect(ip.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('are refused for any host outside the CA’s constraints', async () => {
    const ca = await sharedCa();
    for (const host of ['example.com', 'localhost.example.com', '10.0.0.1', '*.localhost', 'evil.localhost.example']) {
      expect(() => issueLeaf(ca, host), host).toThrow(/cannot certify/);
    }
  });
});

describe('SNI', () => {
  const contextFor = (sni: ReturnType<typeof createSniCallback>, name: string) =>
    new Promise<SecureContext>((resolve, reject) => sni(name, (error, context) => (error ? reject(error) : resolve(context!))));

  it('issues a distinct certificate per application host, once, and refuses a name off the allowlist', async () => {
    const ca = await sharedCa();
    const issued: string[] = [];
    const leaves = createLeafCache(ca);
    const counting = { issue: (host: string) => (issued.push(host), leaves.issue(host)) };
    const sni = createSniCallback(counting, (name) => classifyHostname(name) !== null);
    const a = `${'a'.repeat(32)}.localhost`;
    const b = `${'b'.repeat(32)}.localhost`;
    const first = await contextFor(sni, a);
    expect(await contextFor(sni, a)).toBe(first); // cached
    await contextFor(sni, b);
    expect(issued).toEqual([a, b]);
    expect(leaves.issue(a).certPem).not.toBe(leaves.issue(b).certPem);
    expect(new X509Certificate(leaves.issue(b).certPem).subjectAltName).toBe(`DNS:${b}`);
    for (const name of ['evil.example', 'abc.localhost', `${KEY}.localhost.evil`]) await expect(contextFor(sni, name), name).rejects.toThrow(/Unknown server name/);
    expect(issued).toEqual([a, b]);
  });
});

describe('trusting the CA', () => {
  const ca = { certPath: '/home/u/.builderforce/launcher-ca/ca.pem', derPath: '/home/u/.builderforce/launcher-ca/ca.cer' };
  const storeDir = dirname(ca.derPath);
  const CERTUTIL = 'C:\\Windows\\System32\\certutil.exe';

  it('win32: certutil.exe by absolute path, in the store directory, into the current user’s Root store', () => {
    expect(caTrustCommand(ca, 'win32', '/Users/u', 'C:\\Windows')).toEqual({
      kind: 'command',
      trust: { command: CERTUTIL, args: ['-user', '-addstore', 'Root', ca.derPath], cwd: storeDir, display: `${CERTUTIL} -user -addstore Root ${ca.derPath}` },
    });
    expect(caTrustCommand(ca, 'win32', '/Users/u', 'D:\\WINNT')).toMatchObject({ trust: { command: 'D:\\WINNT\\System32\\certutil.exe' } });
  });

  it('win32: a SystemRoot that is not drive-absolute falls back to C:\\Windows (never the current directory or a share)', () => {
    for (const systemRoot of ['', '.', 'Windows', 'C:Windows', '\\Windows', '\\\\evil\\share', '//evil/share', 'C:\\project\\..\\..\\evil']) {
      expect(windowsCertutil(systemRoot), String(systemRoot)).toBe(CERTUTIL);
      const plan = caTrustCommand(ca, 'win32', '/Users/u', systemRoot);
      expect(plan.kind === 'command' && plan.trust.command, String(systemRoot)).toBe(CERTUTIL);
    }
  });

  it('darwin: /usr/bin/security add-trusted-cert into the login keychain, in the store directory', () => {
    const plan = caTrustCommand(ca, 'darwin', '/Users/u');
    expect(plan).toMatchObject({ kind: 'command', trust: { command: '/usr/bin/security', cwd: storeDir, args: ['add-trusted-cert', '-r', 'trustRoot', '-k', join('/Users/u', 'Library', 'Keychains', 'login.keychain-db'), ca.derPath] } });
  });

  it('every command names its tool by absolute path, whatever SystemRoot says', async () => {
    const local = await sharedCa();
    const commands = [
      ...[undefined, 'relative', process.env.SystemRoot].flatMap((systemRoot) => {
        const plan = caTrustCommand(ca, 'win32', '/Users/u', systemRoot);
        return [plan.kind === 'command' ? plan.trust.command : '', caTrustCheckCommand(local, 'win32', systemRoot)?.command ?? ''];
      }),
      ...[caTrustCommand(ca, 'darwin')].map((plan) => (plan.kind === 'command' ? plan.trust.command : '')),
      caTrustCheckCommand(local, 'darwin')?.command ?? '',
    ];
    for (const command of commands) expect(command).toMatch(/^(?:[A-Za-z]:\\.+\\certutil\.exe|\/usr\/bin\/security)$/);
  });

  it('linux: instructions only (root, and per-browser NSS stores)', () => {
    const plan = caTrustCommand(ca, 'linux');
    expect(plan.kind).toBe('manual');
    expect(plan.kind === 'manual' && plan.instructions).toMatch(/update-ca-certificates/);
    expect(plan.kind === 'manual' && plan.instructions).toMatch(/Firefox/);
  });

  it('the trust check: by thumbprint on win32, verify-cert on darwin, unknown elsewhere', async () => {
    const local = await sharedCa();
    const thumbprint = caThumbprint(local.certPem);
    expect(thumbprint).toBe(new X509Certificate(local.certPem).fingerprint.replace(/:/g, ''));
    expect(caTrustCheckCommand(local, 'win32', 'C:\\Windows')).toMatchObject({ command: CERTUTIL, args: ['-user', '-verifystore', 'Root', thumbprint], cwd: dirname(local.derPath) });
    expect(caTrustCheckCommand(local, 'win32', '.')?.command).toBe(CERTUTIL);
    expect(caTrustCheckCommand(local, 'darwin')).toMatchObject({ command: '/usr/bin/security', args: ['verify-cert', '-c', local.derPath], cwd: dirname(local.derPath) });
    expect(caTrustCheckCommand(local, 'linux')).toBeNull();
  });
});
