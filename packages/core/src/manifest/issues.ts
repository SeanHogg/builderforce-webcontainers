/**
 * `ManifestIssue`: one typed finding about a manifest, located by a dotted
 * `path` (`services.api.port`), so a host can show each issue next to the key it
 * is about. Nothing about a manifest is ever dropped silently: an unreadable
 * file, an unknown reference or an unsupported resource is an issue.
 */
import type { SpecIssue } from '../app/validateSpec.js';
import { describeIssue } from '../app/validateSpec.js';

export type ManifestIssueSeverity = 'error' | 'warning' | 'info';

export type ManifestIssueCode =
  /** The file is not JSON. `detail` is the parser's message. */
  | 'invalid-json'
  /** The JSON is not an object. */
  | 'not-an-object'
  /** No `version`: the unversioned legacy format, read by the host's legacy path. */
  | 'legacy-format'
  | 'unsupported-version'
  /** A section, field or enum value has the wrong shape. `detail` says what was expected. */
  | 'invalid-value'
  /** A required field is absent. `value` names it. */
  | 'missing-field'
  | 'invalid-id'
  /** A resource and a service share an id (both become services of the application). */
  | 'duplicate-id'
  | 'unknown-resource-type'
  /** `uses` names no resource. */
  | 'unknown-resource'
  /** `dependsOn`, a job or an ingress route names no service. */
  | 'unknown-service'
  /** A `redis` queue's `on` does not name a `redis` resource. */
  | 'invalid-queue-host'
  | 'invalid-port'
  | 'duplicate-port'
  | 'invalid-readiness'
  | 'invalid-duration'
  | 'invalid-schedule'
  | 'invalid-timezone'
  /** An `invoke` job calls a service that has no port. */
  | 'invoke-without-port'
  | 'unknown-target'
  | 'invalid-tier'
  | 'debug-in-production'
  | 'unknown-environment'
  /** An environment override names an entry the base manifest does not have. */
  | 'unknown-override-entry'
  /** A frontend `uses` a credentialed resource; frontends never receive credentials. */
  | 'frontend-uses-credentials'
  /** Jobs are declared but the environment's target does not run them yet. */
  | 'jobs-not-run'
  /** A service command line needs a shell (`&&`, `|`, redirects, `FOO=1 cmd`, `$VAR`), and its runtime or target has none. `value` is the line; `detail` says which. */
  | 'shell-command-unsupported'
  /** A command line that needs a shell, plus `args`: joined as text they could be swallowed (`#`, a trailing `&`), so everything belongs in `command`. `value` is the line. */
  | 'shell-command-with-args'
  /** An unquoted backslash before an ordinary character, which the shell drops (`C:\app\x.js` reads `C:appx.js`). A warning. `value` is the line. */
  | 'command-backslash'
  /** The produced `ApplicationSpec` failed `validateSpec`. `spec` holds the issue. */
  | 'spec';

export interface ManifestIssue {
  code: ManifestIssueCode;
  severity: ManifestIssueSeverity;
  /** Dotted path to the key the issue is about; empty for the whole file. */
  path: string;
  /** The offending value, reference or field name, when there is one. */
  value?: string;
  /** Extra context: a parser message, what was expected, a capability reason. */
  detail?: string;
  /** For code `spec`: the `validateSpec` issue. */
  spec?: SpecIssue;
}

/** Builds an issue; `severity` defaults to `error`. */
export function manifestIssue(code: ManifestIssueCode, path: string, extra: Partial<Omit<ManifestIssue, 'code' | 'path'>> = {}): ManifestIssue {
  return { code, path, severity: 'error', ...extra };
}

/** Whether any issue stops the manifest from running. */
export function hasErrors(issues: readonly ManifestIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** Drops repeats of the same (code, path, value). */
export function dedupeIssues(issues: readonly ManifestIssue[]): ManifestIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.path}\u0000${issue.value ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One line a person can read. */
export function describeManifestIssue(issue: ManifestIssue): string {
  const at = issue.path ? `"${issue.path}"` : 'The manifest';
  const detail = issue.detail ? ` ${issue.detail}` : '';
  switch (issue.code) {
    case 'invalid-json':
      return `builderforce.json is not valid JSON:${detail}`;
    case 'not-an-object':
      return 'builderforce.json must hold a JSON object.';
    case 'legacy-format':
      return 'builderforce.json has no "version"; it is read in the legacy format. Add "version": 1 to use the manifest.';
    case 'unsupported-version':
      return `Manifest version ${issue.value ?? '?'} is not supported; this runtime reads version 1.`;
    case 'invalid-value':
      return `${at} has an invalid value${issue.value !== undefined ? ` "${issue.value}"` : ''}.${detail}`;
    case 'missing-field':
      return `${at} is missing "${issue.value ?? '?'}".`;
    case 'invalid-id':
      return `Id "${issue.value ?? issue.path}" must start with a letter and contain only letters, digits, "_" and "-".`;
    case 'duplicate-id':
      return `Id "${issue.value ?? '?'}" names both a resource and a service.`;
    case 'unknown-resource-type':
      return `${at} has unknown resource type "${issue.value ?? '?'}".`;
    case 'unknown-resource':
      return `${at} uses "${issue.value ?? '?'}", which is not a resource of this manifest.`;
    case 'unknown-service':
      return `${at} names "${issue.value ?? '?'}", which is not a service of this manifest.`;
    case 'invalid-queue-host':
      return `${at}: a redis queue must name a redis resource in "on"${issue.value ? `, not "${issue.value}"` : ''}.`;
    case 'invalid-port':
      return `${at} has port ${issue.value ?? '?'}; a port is a whole number from 1 to 65535.`;
    case 'duplicate-port':
      return `Port ${issue.value ?? '?'} is claimed by more than one service.${detail}`;
    case 'invalid-readiness':
      return `${at} must name exactly one readiness check: http, port, query, exitZero or started.${detail}`;
    case 'invalid-duration':
      return `${at} has duration "${issue.value ?? '?'}"; use a whole number with ms, s, m, h or d (e.g. "10m").`;
    case 'invalid-schedule':
      return `${at} has cron schedule "${issue.value ?? '?'}" that cannot be read.${detail}`;
    case 'invalid-timezone':
      return `${at} has time zone "${issue.value ?? '?'}", which is not an IANA time zone.`;
    case 'invoke-without-port':
      return `${at} invokes service "${issue.value ?? '?'}", which has no port to call.`;
    case 'unknown-target':
      return `${at} has unknown target "${issue.value ?? '?'}"; use browser, cloudflare, aws, azure or gcp.`;
    case 'invalid-tier':
      return `${at} has tier "${issue.value ?? '?'}"; use production or non-production.`;
    case 'debug-in-production':
      return `${at} is a production environment with debug on; debug is allowed only on non-production.`;
    case 'unknown-environment':
      return `There is no environment "${issue.value ?? '?'}" in this manifest.`;
    case 'unknown-override-entry':
      return `${at} overrides "${issue.value ?? '?'}", which the manifest does not declare.`;
    case 'frontend-uses-credentials':
      return `${at} is a frontend using "${issue.value ?? '?'}"; a frontend's code ships to the browser, so it never receives its credentials.`;
    case 'jobs-not-run':
      return `${at} will not run on this target.${detail}`;
    case 'shell-command-unsupported':
      return `${at} has command "${issue.value ?? '?'}", which needs a shell (operators, redirects, variable assignments, expansions or globs). Use a single program and its arguments.${detail}`;
    case 'shell-command-with-args':
      return `${at}: command "${issue.value ?? '?'}" needs a shell, so it cannot take "args" as well; put the whole command line in "command".`;
    case 'command-backslash':
      return `${at} has command "${issue.value ?? '?'}" with a backslash the shell drops (a backslash escapes the next character). Use forward slashes in paths, or quote the word.`;
    case 'spec':
      return issue.spec ? describeIssue(issue.spec) : `The application spec is invalid.${detail}`;
  }
}
