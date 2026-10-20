export { VirtualFileSystem } from './vfs.js';
export type { FileContent, FileTree, FlatFiles, FsChange } from './vfs.js';
export type { DirectoryEntry } from './vfs.js';
export { rootedFileSystem, projectToBase, baseToProject } from './rootedFs.js';
export { exportZip, importZip, ZipLimitError, DEFAULT_ZIP_IMPORT_LIMITS } from './archive.js';
export type { ZipExportOptions, ZipImportLimits } from './archive.js';
export { normalizePath, dirname, basename, join, extname } from './paths.js';
export { DevServer } from './devServer.js';
export type { DevServerOptions, ServedFile } from './devServer.js';
export { detectProject } from './detectProject.js';
export type { ProjectKind, ProjectFramework, ProjectProfile } from './detectProject.js';
export { readProjectConfig, parseLooseJson, parseDotenv, envFiles } from './projectConfig.js';
export type { ProjectConfig, PathAlias, BuildMode } from './projectConfig.js';
export { createEsmShCdn, esmShCdnFactory, isRegistryRange, loadPackageManifests } from './packageCdn.js';
export type { PackageCdn, PackageCdnFactory, EsmShOptions, PackageDependencyFields, ManifestLoadOptions } from './packageCdn.js';
export { createEsbuildTransformer, loaderFor } from './transformer.js';
export type { Transformer, TransformRequest, Loader, EsbuildLike } from './transformer.js';
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
export { COMPONENT_EXTENSIONS, componentExtension, staticComponentCompilers, noComponentCompilers } from './components.js';
export type { ComponentCompiler, ComponentCompilers, ComponentExtension, ComponentRequest, CompiledComponent } from './components.js';
export { createVueCompiler } from './vueCompiler.js';
export type { VueCompilerSfcLike, VueDescriptor } from './vueCompiler.js';
export { createSvelteCompiler } from './svelteCompiler.js';
export type { SvelteCompilerLike } from './svelteCompiler.js';
export { contentHash } from './hash.js';
export { rewriteImports } from './rewriteImports.js';
export { resolveLocal, resolveAlias, isBareSpecifier, splitPackageSpecifier, resolvePackage, RESOLVE_EXTENSIONS } from './resolve.js';
export { compileScript, compileModule, isScriptPath, mapSpecifier, moduleUrl, buildDefine } from './compileScript.js';
export { compileComponent } from './compileComponent.js';
export { transformHtml, scriptTag, errorBridgeScript, ERROR_MESSAGE_TYPE, CONSOLE_MESSAGE_TYPE, CONSOLE_MESSAGE_LIMIT } from './html.js';
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
export { previewSocketScript, previewCookieScript, bridgeInsertionPoint, SOCKET_MESSAGE_TYPE, COOKIE_MESSAGE_TYPE, SOCKET_CONNECT_TIMEOUT_MS } from './previewBridge.js';
export { mimeFor } from './mime.js';
export { attributionScript, injectAttribution, ATTRIBUTION_URL, ATTRIBUTION_LABEL } from './attribution.js';
export type { AttributionOptions } from './attribution.js';
export * from './installer/index.js';
export * from './system/index.js';
