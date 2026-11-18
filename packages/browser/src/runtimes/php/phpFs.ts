/**
 * The project's files inside php-wasm's file system, kept in step with the
 * page's both ways. The mirror is the one every Emscripten runtime uses
 * (runtimes/emscripten/projectMirror.ts: the mount at `/project`, copying in,
 * replaying page ops, batching changes out). php-wasm's Emscripten build has
 * no `trackingDelegate`, so the program's changes are heard by wrapping its FS
 * calls (runtimes/emscripten/wrappedFsWrites.ts).
 */
export { PROJECT_MOUNT, toMountPath as toPhpPath, fromMountPath as fromPhpPath, copyIntoMount as copyIntoPhp, applyOpsToMount as applyOpsToPhp } from '../emscripten/projectMirror.js';
