/**
 * The launcher's local certificate authority (Node only): ONE self-signed CA per
 * user, persisted in a store directory, that signs the launcher's per-host leaf
 * certificates (`issueCert.ts`) so its origins are real https origins.
 *
 * The CA is name-constrained (critical `nameConstraints`, RFC 5280 §4.2.1.10):
 * it may only certify `localhost`, `*.localhost` and the IP 127.0.0.1 — so even a
 * leaked key cannot mint a certificate a browser would accept for a real site. It
 * is a CA with `pathLen 0` (no intermediates) and key usage `keyCertSign, cRLSign`
 * only, valid for five years.
 *
 * `loadOrCreateLocalCa` reuses the stored CA only when it is exactly what this
 * module writes (`caProblem`), and regenerates it when a file is missing or
 * corrupt, the key does not match the certificate, its extensions differ, or it
 * expires within 30 days. Files are written 0600 (temp file + rename) in a 0700
 * directory. Certificates are built with node-forge (Node has no X.509 signing API);
 * keys come from Node's `crypto`.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import forge from 'node-forge';

const { pki, asn1, md } = forge;

export const CA_COMMON_NAME = 'Builderforce Local Launcher CA';

/** The CA's files in the store directory. */
export const CA_FILES = { cert: 'ca.pem', der: 'ca.cer', key: 'ca-key.pem' } as const;

const DAY_MS = 86_400_000;
const CA_VALIDITY_DAYS = 5 * 365;
/** Regenerate when the CA would expire within this. */
const RENEW_BEFORE_DAYS = 30;

export interface LocalCa {
  /** The CA certificate, PEM. */
  certPem: string;
  /** Its private key, PEM (PKCS#1). Never leaves the store directory or this process. */
  keyPem: string;
  /** Where the PEM certificate is (`ca.pem`). */
  certPath: string;
  /** The same certificate, DER (`ca.cer`): what the OS trust stores import. */
  derPath: string;
}

/**
 * A random serial number (hex, 16 bytes), positive and minimally DER-encoded: the
 * top bit clear (no sign) and the next set (no leading zero byte to strip), so the
 * first byte is always 0x40–0x7f. CAs and leaves share it.
 */
export function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x40;
  return bytes.toString('hex');
}

/** A fresh RSA-2048 key pair as forge keys. */
export function newRsaKeys(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey; keyPem: string } {
  const { privateKey: keyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const privateKey = pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  return { privateKey, publicKey: pki.setRsaPublicKey(privateKey.n, privateKey.e), keyPem };
}

/**
 * The `nameConstraints` value: permitted subtrees DNS `localhost`, DNS `.localhost`
 * and IP 127.0.0.1/255.255.255.255; nothing else may be certified.
 */
export function loopbackNameConstraints(): forge.asn1.Asn1 {
  const { Class, Type } = asn1;
  const subtree = (base: forge.asn1.Asn1) => asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [base]);
  const dns = (name: string) => subtree(asn1.create(Class.CONTEXT_SPECIFIC, 2, false, name));
  const ip = subtree(asn1.create(Class.CONTEXT_SPECIFIC, 7, false, String.fromCharCode(127, 0, 0, 1, 255, 255, 255, 255)));
  const permitted = asn1.create(Class.CONTEXT_SPECIFIC, 0, true, [dns('localhost'), dns('.localhost'), ip]);
  return asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [permitted]);
}

/** A new CA certificate and key, valid from `now` for five years. */
export function createLocalCaCertificate(now: Date = new Date()): { certPem: string; keyPem: string } {
  const keys = newRsaKeys();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS);
  const subject = [{ name: 'commonName', value: CA_COMMON_NAME }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
    { id: '2.5.29.30', name: 'nameConstraints', critical: true, value: loopbackNameConstraints() },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { certPem: pki.certificateToPem(cert), keyPem: keys.keyPem };
}

/** A parsed certificate extension, as forge reads it (`value`: the extnValue's DER bytes). */
interface ParsedExtension {
  id: string;
  critical: boolean;
  value: string;
  cA?: boolean;
  pathLenConstraint?: number;
  [flag: string]: unknown;
}

const KEY_USAGE_FLAGS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'] as const;

/** Why the CA's extensions are not exactly the ones `createLocalCaCertificate` writes (null: they are). */
function extensionProblem(cert: forge.pki.Certificate): string | null {
  const extensions = cert.extensions as ParsedExtension[];
  const only = (id: string) => {
    const found = extensions.filter((extension) => extension.id === id);
    return found.length === 1 ? found[0]! : undefined;
  };
  const constraints = only('2.5.29.30');
  if (!constraints) return 'it has no name constraints';
  if (!constraints.critical) return 'its name constraints are not critical';
  if (constraints.value !== asn1.toDer(loopbackNameConstraints()).getBytes()) return 'its name constraints are not the loopback ones';
  const basic = only('2.5.29.19');
  if (!basic?.critical || basic.cA !== true || basic.pathLenConstraint !== 0) return 'it is not a critical pathLen-0 CA';
  const usage = only('2.5.29.15');
  if (!usage?.critical || KEY_USAGE_FLAGS.some((flag) => usage[flag] !== (flag === 'keyCertSign' || flag === 'cRLSign'))) return 'its key usage is not keyCertSign and cRLSign only';
  return null;
}

/** Whether `cert` is its own issuer and its signature verifies with its own key (forge throws on a bad RSA block). */
function selfSigned(cert: forge.pki.Certificate): boolean {
  try {
    return cert.issued(cert) && cert.verify(cert);
  } catch {
    return false; // a signature by another key: not self-signed, reported as such by the caller
  }
}

/**
 * Why the stored CA cannot be reused (null: it can). Reused only when it is exactly
 * what this module writes: the launcher CA's name, self-signed by the stored key, a
 * critical pathLen-0 CA for keyCertSign and cRLSign only, with the critical loopback
 * name constraints byte for byte — a planted unconstrained or looser CA is replaced.
 */
export function caProblem(certPem: string, keyPem: string, now: Date = new Date()): string | null {
  try {
    const cert = pki.certificateFromPem(certPem);
    const key = pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
    if (publicKey.n.compareTo(key.n) !== 0 || publicKey.e.compareTo(key.e) !== 0) return 'the key does not match the certificate';
    if (cert.subject.getField('CN')?.value !== CA_COMMON_NAME) return 'it is not the launcher CA';
    if (!selfSigned(cert)) return 'it is not self-signed';
    const extensions = extensionProblem(cert);
    if (extensions) return extensions;
    if (cert.validity.notAfter.getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS) return 'it expires within 30 days';
    if (cert.validity.notBefore.getTime() > now.getTime()) return 'it is not valid yet';
    return null;
  } catch (error) {
    return `it is unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write `data` to `target` in `storeDir` atomically: a fresh temp file created 0600
 * (exclusively — never an existing file whose old mode would stay) beside it, then
 * renamed over it, so `target` is never half-written nor briefly readable at a looser
 * mode. The temp file is removed when anything fails.
 */
async function writePrivateFile(storeDir: string, target: string, data: string | Buffer): Promise<void> {
  const temp = join(storeDir, `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * The CA stored in `storeDir`, created (or regenerated) when it cannot be reused.
 *
 * The store directory is 0700 and each file 0600 on POSIX (re-applied to a directory
 * that already existed). On Windows those modes are no-ops: the store relies on the
 * user-profile ACL it lives under (the user, SYSTEM and Administrators only), and the
 * CA's critical name constraints bound a leaked key to loopback names anyway.
 */
export async function loadOrCreateLocalCa(storeDir: string, now: Date = new Date()): Promise<LocalCa> {
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  await chmod(storeDir, 0o700); // mkdir's mode applies only to a directory it creates
  const certPath = join(storeDir, CA_FILES.cert);
  const derPath = join(storeDir, CA_FILES.der);
  const keyPath = join(storeDir, CA_FILES.key);
  const [storedCert, storedKey] = await Promise.all([readOptional(certPath), readOptional(keyPath)]);
  if (storedCert !== null && storedKey !== null && caProblem(storedCert, storedKey, now) === null) {
    if ((await readOptional(derPath)) === null) await writePrivateFile(storeDir, derPath, derOf(storedCert));
    return { certPem: storedCert, keyPem: storedKey, certPath, derPath };
  }
  const { certPem, keyPem } = createLocalCaCertificate(now);
  await writePrivateFile(storeDir, keyPath, keyPem);
  await writePrivateFile(storeDir, certPath, certPem);
  await writePrivateFile(storeDir, derPath, derOf(certPem));
  return { certPem, keyPem, certPath, derPath };
}

/** A PEM certificate's DER bytes. */
export function derOf(certPem: string): Buffer {
  return Buffer.from(asn1.toDer(pki.certificateToAsn1(pki.certificateFromPem(certPem))).getBytes(), 'binary');
}
