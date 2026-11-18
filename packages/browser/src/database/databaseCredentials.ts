/**
 * The logins a runtime's databases accept (make.md › PRD 31 §4 W10, control 5).
 * One login per (database, client service), generated with
 * `crypto.getRandomValues` the first time the client's environment is built —
 * never the spec's static password — and held here, on the page, for as long
 * as the provider lives. Never written to the VFS: the client gets it only in
 * its `DATABASE_URL`. Only a backend that declares `dependsOn` the database is
 * issued one (`mayConnectToDatabase`); a frontend never is.
 *
 * `databaseAuthenticator` turns the logins into the gateway's admission rule.
 */
import { databaseName, mayConnectToDatabase, type DatabaseCredential, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { ALLOW, deny, isApplicationId, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ConnectionAuthenticator } from './pgAuthentication.js';

interface Login extends DatabaseCredential {
  readonly clientServiceId: string;
}

/** Fills `bytes` with random values (`crypto.getRandomValues`). */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandom: RandomSource = (bytes) => void globalThis.crypto.getRandomValues(bytes);

const randomHex = (random: RandomSource, length: number) => {
  const bytes = new Uint8Array(length);
  random(bytes);
  return hex(bytes);
};

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Compare without an early exit, so the time taken does not reveal how much of a password matched. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0); // NaN past the end | 0 = 0
  return diff === 0;
}

/** A database is one service on one port; two applications' `db`s on different ports are different databases. */
const databaseKey = (database: ServiceSpec) => `${database.port ?? ''}/${database.id}`;

export class DatabaseCredentials {
  private readonly logins = new Map<string, Map<string, Login>>();

  constructor(private readonly random: RandomSource = defaultRandom) {}

  /** The login `client` connects to `database` with (the same one every time), or undefined when it may not hold one. */
  issue(database: ServiceSpec, client: ServiceSpec): DatabaseCredential | undefined {
    if (!mayConnectToDatabase(client, database)) return undefined;
    const key = databaseKey(database);
    let byClient = this.logins.get(key);
    if (!byClient) this.logins.set(key, (byClient = new Map()));
    let login = byClient.get(client.id);
    if (!login) {
      // URL-safe without encoding (PHP's parse_url and Python's urlparse do not decode).
      const name = client.id.toLowerCase().replace(/[^a-z0-9]/g, '_');
      login = { user: `${name}_${randomHex(this.random, 4)}`, password: randomHex(this.random, 24), clientServiceId: client.id };
      byClient.set(client.id, login);
    }
    return { user: login.user, password: login.password };
  }

  /** Has `clientServiceId` been issued a login for `database`? */
  issuedTo(database: ServiceSpec, clientServiceId: string): boolean {
    return this.logins.get(databaseKey(database))?.has(clientServiceId) ?? false;
  }

  /** The client service whose login `user` / `password` is, or undefined when it is not one. */
  verify(database: ServiceSpec, user: string, password: string): string | undefined {
    for (const login of this.logins.get(databaseKey(database))?.values() ?? []) {
      if (login.user === user) return constantTimeEqual(password, login.password) ? login.clientServiceId : undefined;
    }
    return undefined;
  }
}

const isHostSide = (caller: SecurityContext) => !isApplicationId(caller.applicationId);

/**
 * The gateway's admission rule for one database service, decided on the page
 * against the dialler's page-side identity (never `application_name`):
 * 1. an application service must have been issued a login for this database
 *    (a frontend, or a service without the `dependsOn` edge, never is) —
 *    otherwise `db.service_not_allowed`; the platform and the workspace pass on
 *    to authenticate;
 * 2. the password must be a login of this database — `db.auth_failed` — and an
 *    application service must use its own — `db.service_not_allowed`;
 * 3. the database named must be the one the spec owns — `db.not_owner`.
 */
export function databaseAuthenticator(credentials: DatabaseCredentials, database: ServiceSpec): ConnectionAuthenticator {
  const owned = databaseName(database, database.database!);
  return ({ caller, user, database: requested }) => {
    if (!caller) return deny('db.service_not_allowed');
    if (!isHostSide(caller) && !credentials.issuedTo(database, caller.serviceId)) return deny('db.service_not_allowed');
    return {
      allow: true,
      verify(password) {
        const clientServiceId = credentials.verify(database, user, password);
        if (clientServiceId === undefined) return deny('db.auth_failed');
        if (!isHostSide(caller) && clientServiceId !== caller.serviceId) return deny('db.service_not_allowed');
        return requested === owned ? ALLOW : deny('db.not_owner');
      },
    };
  };
}
