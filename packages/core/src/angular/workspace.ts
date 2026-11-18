import { parseLooseJson } from '../projectConfig.js';

/**
 * The parts of `angular.json` the instant preview honours: what the browser
 * build of the chosen application project starts from. Everything else in the
 * build options (aot, optimization, outputHashing, budgets, ssr, server,
 * prerender, outputMode, i18n, localize, …) is ignored — this runtime has one
 * way to build, and it is the JIT one.
 */
export interface AngularAsset {
  /** Workspace-relative file or directory (`src/favicon.ico`, `public`). */
  input: string;
  /** Glob under `input`; only `**\/*`-style "everything" globs are honoured as such. */
  glob?: string;
  /** Output directory relative to the site root (object form only). */
  output?: string;
}

export interface AngularWorkspace {
  /** The project chosen: `defaultProject`, else the first application, else the first. */
  project: string;
  /** Workspace-relative source root (`src`). */
  sourceRoot: string;
  /** The entry module: `browser` (application builder) or `main` (browser builder). */
  main?: string;
  /** The HTML page. */
  index?: string;
  /** Global stylesheets, in order (those marked `inject: false` are left out). */
  styles: string[];
  assets: AngularAsset[];
  /** Polyfill package specifiers or workspace-relative files, in order. */
  polyfills: string[];
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

function chooseProject(workspace: Json): [string, Json] | undefined {
  const projects = Object.entries(record(workspace.projects));
  if (!projects.length) return undefined;
  const preferred = str(workspace.defaultProject);
  const [name, project] =
    projects.find(([candidate]) => candidate === preferred) ??
    projects.find(([, candidate]) => record(candidate).projectType === 'application') ??
    projects[0]!;
  return [name, record(project)];
}

function readStyles(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of list(value)) {
    if (typeof entry === 'string') out.push(entry);
    else if (record(entry).inject !== false && str(record(entry).input)) out.push(str(record(entry).input)!);
  }
  return out;
}

function readAssets(value: unknown): AngularAsset[] {
  const out: AngularAsset[] = [];
  for (const entry of list(value)) {
    if (typeof entry === 'string') out.push({ input: entry });
    else {
      const input = str(record(entry).input);
      if (input !== undefined) out.push({ input, glob: str(record(entry).glob), output: str(record(entry).output) });
    }
  }
  return out;
}

/** The workspace, from `angular.json` text; undefined when it is not valid JSON or has no projects. */
export function readAngularWorkspace(text: string): AngularWorkspace | undefined {
  let workspace: Json;
  try {
    workspace = record(parseLooseJson(text));
  } catch {
    return undefined;
  }
  const chosen = chooseProject(workspace);
  if (!chosen) return undefined;
  const [project, config] = chosen;
  const options = record(record(record(config.architect ?? config.targets).build).options);
  const index = options.index;
  return {
    project,
    sourceRoot: str(config.sourceRoot) ?? 'src',
    main: str(options.browser) ?? str(options.main),
    index: str(index) ?? str(record(index).input),
    styles: readStyles(options.styles),
    assets: readAssets(options.assets),
    polyfills: list(options.polyfills).filter((p): p is string => typeof p === 'string'),
  };
}
