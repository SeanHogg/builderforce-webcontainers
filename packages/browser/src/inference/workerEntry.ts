/**
 * Phase 1 — Local CPU Inference Engine: worker entry.
 *
 * Bundled to `dist/inference/worker.bundle.js` (see `scripts/build-sw.mjs`;
 * exported as `@seanhogg/builderforce-webcontainers/ml/worker.js`). Backends
 * are listed in preference order; `mock` is last so a real backend always
 * wins when its module is present. The ONNX/Wllama/WebLLM adapters take an
 * injected `loadModule()` so this package stays dependency-free — a host app
 * that installs `onnxruntime-web` (or wllama / `@mlc-ai/web-llm`) and wants
 * the worker to use it wires that in here. For now the worker runs the
 * deterministic mock backend, which is what the tests and the
 * offline/caching paths exercise.
 */

import { runInferenceWorker } from './worker.js';
import { createMockBackend } from './backends/mock.js';

runInferenceWorker([createMockBackend()]);
