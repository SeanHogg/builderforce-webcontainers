/**
 * The real runtime behind {@link BootDeps}: this package's own preview runtime and
 * application runtime, with every provider — Node, PGlite, Python (Pyodide), PHP
 * (php-wasm), .NET and Rust. Python and PHP load from their default CDN sources;
 * .NET from the bundle the launcher serves (`launch.json` › `dotnet`).
 */
import {
  createDotnetProvider, createNodeProvider, createPgliteProvider, createPhpProvider, createPythonProvider, createRustProvider, startApplicationRuntime,
  type PhpHostOptions,
} from '../../app.js';
import { startPreviewRuntime } from '../../host.js';
import { previewOriginTemplate } from '../../previewOrigin.js';
import type { BootDeps } from './bootApplication.js';

const PHP_OPTIONS: PhpHostOptions = {};

export const runtimeDeps: BootDeps = {
  startPreviewRuntime,
  previewOriginTemplate,
  startApplicationRuntime,
  phpOptions: PHP_OPTIONS,
  providers: (runtime) => [
    createNodeProvider(runtime),
    createPgliteProvider(runtime),
    // No training: the launcher boots without `python.training`, so the provider declines training services with its reason.
    createPythonProvider(runtime, { fs: runtime.fs, training: runtime.pythonTraining }),
    createPhpProvider(runtime, { fs: runtime.fs, php: PHP_OPTIONS, platform: runtime.phpPlatform }),
    createDotnetProvider(runtime, { fs: runtime.fs }),
    createRustProvider(runtime, { fs: runtime.fs }),
  ],
};
