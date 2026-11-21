/**
 * The launcher page's "Copy diagnostics" text: everything the page shows, as one
 * plain-text report a person can paste into an issue — when and where, the
 * application and its environment, the launch status, each service, every issue
 * and decline, and every buffered log line (all services, whatever the log
 * filter shows). Pure: built from the page's own state, never the runtime's.
 * Its field names are fixed English on purpose: it is read by whoever debugs
 * the launch, whatever language the page speaks. Every line goes through the
 * shield's `scrubCredentials`, and the report opens by saying to review it.
 */
import type { ServiceSnapshot } from '../../app/types.js';
import { scrubCredentials } from '../../security/securityEvent.js';
import type { LaunchHeader, PlanMessage } from './launchPlan.js';
import type { LogLine } from './logBuffer.js';

export interface DiagnosticsState {
  /** When the report was taken. */
  now: Date;
  pageUrl: string;
  userAgent: string;
  /** Null until the launch answered. */
  header: LaunchHeader | null;
  /** The header's status line, and whether it is the start error. */
  status: { text: string; tone: 'busy' | 'ok' | 'error' };
  /** The issues panel's summary (a blocked launch's reason), when shown. */
  summary?: string;
  services: readonly ServiceSnapshot[];
  problems: readonly PlanMessage[];
  logs: { lines: readonly LogLine[]; dropped: number };
}

const section = (title: string, lines: readonly string[], empty: string): string[] => [``, `## ${title}`, ...(lines.length > 0 ? lines : [empty])];

function serviceLine(service: ServiceSnapshot): string {
  const parts = [`${service.id}`, `runtime=${service.runtime}`, `state=${service.state}`];
  if (service.port !== undefined) parts.push(`port=${service.port}`);
  parts.push(`restarts=${service.restarts}`);
  if (service.exitCode !== undefined) parts.push(`exit=${service.exitCode}`);
  if (service.url) parts.push(`url=${service.url}`);
  const line = `- ${parts.join(' ')}`;
  if (!service.error) return line;
  const { phase, message, exitCode, willRestart } = service.error;
  return `${line}\n  failure (${phase}${exitCode !== undefined ? `, exit ${exitCode}` : ''}${willRestart ? ', will restart' : ''}): ${message}`;
}

function problemLine(problem: PlanMessage): string {
  const kind = problem.kind === 'declined' ? 'declined' : problem.kind === 'skipped' ? `skipped ${problem.severity}` : problem.severity;
  return `- [${kind}]${problem.subject ? ` ${problem.subject}:` : ''} ${problem.text}`;
}

export function buildDiagnosticsReport(state: DiagnosticsState): string {
  const { header } = state;
  const lines = [
    'Builderforce launcher diagnostics',
    'Review before sharing: logs may contain secrets. Credentials in URLs, Bearer/Basic values and key=value secrets are redacted; anything else is as logged.',
    `Time: ${state.now.toISOString()}`,
    `Page: ${state.pageUrl}`,
    `User agent: ${state.userAgent}`,
    '',
    '## Application',
    `Name: ${header?.name ?? '(unknown)'}`,
    `Environment: ${header?.environment ?? '(none)'}`,
    `Target: ${header?.target ?? '(none)'}`,
    `Production: ${header?.tier === 'production' ? 'yes' : header?.tier === 'non-production' ? 'no' : '(unknown)'}`,
    `Status: ${state.status.text}`,
    `Start error: ${state.status.tone === 'error' ? state.status.text : '(none)'}`,
  ];
  if (state.summary) lines.push(`Summary: ${state.summary}`);
  lines.push(...section(`Services (${state.services.length})`, state.services.map(serviceLine), '(none)'));
  lines.push(...section(`Issues and declines (${state.problems.length})`, state.problems.map(problemLine), '(none)'));
  const logHead = state.logs.dropped > 0 ? `Logs (${state.logs.lines.length} lines, ${state.logs.dropped} earlier lines dropped)` : `Logs (${state.logs.lines.length} lines)`;
  lines.push(...section(logHead, state.logs.lines.map((line) => `[${line.serviceId}]${line.source === 'runtime' ? ' (runtime)' : ''} ${line.text}`), '(no output)'));
  // Every line, not just the logs: a URL with credentials can be in a service URL, an error or an issue.
  return `${lines.map(scrubCredentials).join('\n')}\n`;
}
