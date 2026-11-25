export { VirtualFileSystem } from './vfs.js';
export type { FileContent, FileTree, FlatFiles, FsChange } from './vfs.js';
export type { DirectoryEntry, SeedContent, WatchOptions } from './vfs.js';
export { applyOps, changeToOp } from './vfs/journal.js';
export type { VfsOp } from './vfs/journal.js';
export { VfsSnapshots, mountSnapshot } from './vfs/snapshots.js';
export type { VfsSnapshot, VfsDelta, SnapshotOptions } from './vfs/snapshots.js';
export { rootedFileSystem, projectToBase, baseToProject } from './rootedFs.js';
export { exportZip, importZip, ZipLimitError, DEFAULT_ZIP_IMPORT_LIMITS } from './archive.js';
export type { ZipExportOptions, ZipImportLimits } from './archive.js';
export { normalizePath, dirname, basename, join, extname, resolveFrom } from './paths.js';
export { DevServer } from './devServer.js';
export type { DevServerOptions, ServedFile } from './devServer.js';
export { detectProject } from './detectProject.js';
export type { DetectProjectOptions, ProjectKind, ProjectFramework, ProjectProfile } from './detectProject.js';
export { readProjectConfig, parseLooseJson, parseDotenv, envFiles } from './projectConfig.js';
export type { ProjectConfig, PathAlias, BuildMode } from './projectConfig.js';
export { ESM_SH_ORIGIN, createEsmShCdn, createEsmShCdnFactory, esmShCdnFactory, isRegistryRange, loadPackageManifests } from './packageCdn.js';
export type { PackageCdn, PackageCdnFactory, EsmShOptions, PackageDependencyFields, ManifestLoadOptions } from './packageCdn.js';
export { createEsbuildTransformer, loaderFor } from './transformer.js';
export type { Transformer, TransformRequest, Loader, EsbuildLike, TypeScriptOptions, EsbuildTypeScriptOptions } from './transformer.js';
export { createEsbuildBundler } from './bundler.js';
export type {
  Bundler,
  BundleRequest,
  BundleOutput,
  BundleOutputFile,
  BundleHost,
  BundleLoad,
  BundleLoader,
  BundleResolution,
  ResolveKind,
  EsbuildBuildLike,
} from './bundler.js';
export { buildProject, normalizeBase } from './build.js';
export type { BuildOptions, BuildResult, BuiltFile } from './build.js';
export { createBuildHost } from './buildHost.js';
export type { BuildHost, BuildHostOptions } from './buildHost.js';
export { findHtmlEntries, rewriteBuiltHtml } from './buildHtml.js';
export type { HtmlEntry, BuiltHtmlOptions } from './buildHtml.js';
export { COMPONENT_EXTENSIONS, componentExtension, componentKindFor, staticComponentCompilers, noComponentCompilers } from './components.js';
export type { ComponentCompiler, ComponentCompilers, ComponentExtension, ComponentKind, ComponentRequest, CompiledComponent } from './components.js';
export { angularCompilerFor, ANGULAR_MAJORS } from './angular/compiler.js';
export type { StaticDir } from './staticDirs.js';
export { createVueCompiler } from './vueCompiler.js';
export type { VueCompilerSfcLike, VueDescriptor } from './vueCompiler.js';
export { createSvelteCompiler } from './svelteCompiler.js';
export type { SvelteCompilerLike } from './svelteCompiler.js';
export { contentHash } from './hash.js';
/** Synchronous digests (md5, sha1, sha2): the browser runtime derives per-application preview origins with sha256. */
export { hashAlgorithm } from './node/hashes.js';
export { rewriteImports } from './rewriteImports.js';
export { resolveLocal, resolveAlias, isBareSpecifier, splitPackageSpecifier, resolvePackage, RESOLVE_EXTENSIONS } from './resolve.js';
export { compileScript, compileModule, isScriptPath, mapSpecifier, moduleUrl, buildDefine } from './compileScript.js';
export { compileComponent } from './compileComponent.js';
export { transformHtml, scriptTag, errorBridgeScript, ERROR_MESSAGE_TYPE, CONSOLE_MESSAGE_TYPE, CONSOLE_MESSAGE_LIMIT, ERROR_MESSAGE_LIMIT } from './html.js';
export type { PreviewErrorSource, ErrorBridgeOptions } from './html.js';
export { previewErrorText, stripAnsi } from './previewErrorText.js';
export type { PreviewErrorText } from './previewErrorText.js';
export { hotUpdateScript, updateChannelName } from './hot/client.js';
export type { PreviewUpdate, HotUpdate, HotStyle } from './hot/client.js';
export { ModuleGraph } from './hot/moduleGraph.js';
export type { ModuleFacts } from './hot/moduleGraph.js';
export { planUpdate } from './hot/planUpdate.js';
export type { UpdatePlan, PlanInput } from './hot/planUpdate.js';
export { usesReactRefresh, refreshPreambleScript, componentNames, refreshFooter, hookSignature, refreshFacts, REFRESH_GLOBAL } from './hot/reactRefresh.js';
export { styleLanguageOf, isStylesheet, isCssModule, styleLanguageOfLang } from './styles/languages.js';
export type { StyleLanguage } from './styles/languages.js';
export { createSassCompiler, createLessCompiler, staticStyleCompilers, noStyleCompilers, sassCandidates, lessCandidates } from './styles/compilers.js';
export type { StyleCompiler, StyleCompilers, StyleCompileRequest, CompiledStyle, PreprocessedLanguage, SassLike, LessLike } from './styles/compilers.js';
export { createStyleImportHost, jsDelivrFileUrl } from './styles/imports.js';
export type { StyleImportHost, StyleImportHostOptions, StyleSource } from './styles/imports.js';
export { compileStylesheet, preprocessStyleBlock } from './styles/compile.js';
export type { StylesheetContext } from './styles/compile.js';
export { scopeCssModule, cssModuleToModule } from './styles/cssModules.js';
export type { ScopedCssModule, ComposedClass } from './styles/cssModules.js';
export { PACKAGE_STYLE_DIR, packageStylePath, packageStyleSpecifier, linkStylesheetModule } from './styles/packageStyles.js';
export { previewSocketScript, previewFetchScript, previewCookieScript, bridgeInsertionPoint, SOCKET_MESSAGE_TYPE, COOKIE_MESSAGE_TYPE, SOCKET_CONNECT_TIMEOUT_MS } from './previewBridge.js';
export { previewDiagnosticsScript, cspBlockedOrigin, CSP_VIOLATION_MESSAGE_TYPE, TIMING_MESSAGE_TYPE, CSP_VIOLATION_LIMIT, TIMING_ENTRY_LIMIT, TIMING_BATCH_SIZE, PREVIEW_TIMING_FEATURES } from './previewDiagnostics.js';
export { mimeFor } from './mime.js';
export { attributionScript, attributionFromMarker, injectAttribution, ATTRIBUTION_URL, ATTRIBUTION_LABEL, ATTRIBUTION_OFF_MARKER } from './attribution.js';
export type { AttributionOptions, AttributionSetting } from './attribution.js';
// The preview1 WASI host over a VirtualFileSystem (node:wasi's, and the Rust runtime's in the browser package).
export { WasiExit } from './node/wasi/index.js';
export type { WasiHost } from './node/wasi/index.js';
export { createVfsWasi } from './node/wasi/vfsWasi.js';
export type { VfsWasiOptions } from './node/wasi/vfsWasi.js';
export * from './installer/index.js';
export * from './system/index.js';
export * from './capabilities/index.js';
export * from './agents/index.js';
