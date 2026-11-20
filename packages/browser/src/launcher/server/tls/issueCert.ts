/**
 * Leaf certificates for the launcher's hosts (Node only), signed by the local CA
 * (`localCa.ts`): one per host — `localhost`, `127.0.0.1`, each `<key>.localhost` —
 * because browsers ignore a `*.localhost` wildcard. Each names exactly its host
 * (SAN DNS, or SAN IP for 127.0.0.1), is for `serverAuth` only, and is valid for at
 * most 397 days (never past the CA). Keys are RSA-2048 from Node's `crypto`.
 */
import forge from 'node-forge';
import { newRsaKeys, randomSerial, type LocalCa } from './localCa.js';

const { pki, md } = forge;

const DAY_MS = 86_400_000;
/** The longest leaf validity browsers accept. */
export const LEAF_VALIDITY_DAYS = 397;

/** A host the CA's name constraints permit: `localhost`, a `*.localhost` name, or 127.0.0.1. */
export function isLoopbackCertHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/.test(host);
}

export interface LeafCertificate {
  host: string;
  certPem: string;
  keyPem: string;
}

/** A leaf for exactly `host` (lowercase), signed by `ca`. Throws for a host outside the CA's constraints. */
export function issueLeaf(ca: LocalCa, host: string, now: Date = new Date()): LeafCertificate {
  const name = host.toLowerCase();
  if (!isLoopbackCertHost(name)) throw new Error(`The launcher CA cannot certify "${host}".`);
  const caCert = pki.certificateFromPem(ca.certPem);
  const caKey = pki.privateKeyFromPem(ca.keyPem);
  const keys = newRsaKeys();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = new Date(Math.min(notBefore.getTime() + LEAF_VALIDITY_DAYS * DAY_MS, caCert.validity.notAfter.getTime()));
  cert.setSubject([{ name: 'commonName', value: name }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [name === '127.0.0.1' ? { type: 7, ip: name } : { type: 2, value: name }] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, md.sha256.create());
  return { host: name, certPem: pki.certificateToPem(cert), keyPem: keys.keyPem };
}

/** Leaves issued once per host and kept in memory for the launcher's lifetime. */
export interface LeafCache {
  issue(host: string): LeafCertificate;
}

export function createLeafCache(ca: LocalCa): LeafCache {
  const leaves = new Map<string, LeafCertificate>();
  return {
    issue(host) {
      const name = host.toLowerCase();
      let leaf = leaves.get(name);
      if (!leaf) {
        leaf = issueLeaf(ca, name);
        leaves.set(name, leaf);
      }
      return leaf;
    },
  };
}
