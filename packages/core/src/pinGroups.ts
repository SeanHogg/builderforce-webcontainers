import { isRegistryRange } from './packageCdn.js';

/**
 * Packages that must load at ONE version for a framework to work, pinned from
 * the framework's own range. esm.sh links a package's imports to the versions
 * in `deps=`, so a package the project imports but never declared (Angular apps
 * rarely declare `@angular/compiler`) would otherwise resolve to `latest` — a
 * second, mismatched copy of the framework. Data, not branches: another
 * framework is another row.
 */
export interface PinGroup {
  /** The dependency that switches the group on and supplies the range. */
  anchor: string;
  /** Released in lockstep with the anchor: forced to its range when declared, added at it when `implied`. */
  lockstep: readonly string[];
  /** Lockstep packages added at the anchor's range even when undeclared (commonly imported). */
  implied: readonly string[];
  /** Companion ranges by the anchor's major, used only when the project declares none. */
  companions: Readonly<Record<number, Readonly<Record<string, string>>>>;
}

const ANGULAR_COMPANIONS = { rxjs: '~7.8.0', tslib: '^2.3.0' };

export const PIN_GROUPS: readonly PinGroup[] = [
  {
    anchor: '@angular/core',
    // The packages released from angular/angular. Not @angular/cdk, material,
    // cli, build or ssr: they have their own release trains, and forcing them
    // to core's range can name a version that does not exist.
    lockstep: [
      '@angular/animations', '@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core',
      '@angular/elements', '@angular/forms', '@angular/language-service', '@angular/localize',
      '@angular/platform-browser', '@angular/platform-browser-dynamic', '@angular/platform-server',
      '@angular/router', '@angular/service-worker', '@angular/upgrade',
    ],
    implied: [
      '@angular/animations', '@angular/common', '@angular/compiler', '@angular/core',
      '@angular/forms', '@angular/platform-browser', '@angular/router',
    ],
    companions: { 17: ANGULAR_COMPANIONS, 18: ANGULAR_COMPANIONS, 19: ANGULAR_COMPANIONS, 20: ANGULAR_COMPANIONS },
  },
];

/** The major version a semver range names (`^20.1.0`, `~17.3`, `20.x` → its number), or undefined. */
export function rangeMajor(range: string): number | undefined {
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : undefined;
}

/** `dependencies` with every applicable {@link PIN_GROUPS} row applied. Returns a new record. */
export function applyPinGroups(dependencies: Readonly<Record<string, string>>, groups: readonly PinGroup[] = PIN_GROUPS): Record<string, string> {
  const out: Record<string, string> = { ...dependencies };
  for (const group of groups) {
    const range = dependencies[group.anchor];
    if (!range || !isRegistryRange(range)) continue;
    for (const name of group.lockstep) if (Object.hasOwn(dependencies, name)) out[name] = range;
    for (const name of group.implied) out[name] ??= range;
    const major = rangeMajor(range);
    const companions = major === undefined ? undefined : group.companions[major];
    for (const [name, companion] of Object.entries(companions ?? {})) out[name] ??= companion;
  }
  return out;
}
