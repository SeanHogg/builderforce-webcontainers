/**
 * `@seanhogg/builderforce-webcontainers/manifest` — where the app manifest lives.
 * Node only (`locateManifest` reads the filesystem). The manifest schema itself
 * stays in `@seanhogg/builderforce-webcontainers-core/manifest`.
 */
export {
  LEGACY_MANIFEST_DEPRECATION,
  LEGACY_MANIFEST_FILES,
  MANIFEST_FILE,
  WORKSPACE_DIR,
  locateManifest,
  manifestWritePath,
} from './locate.js';
export type { LocatedManifest, ManifestLocateSource } from './locate.js';
