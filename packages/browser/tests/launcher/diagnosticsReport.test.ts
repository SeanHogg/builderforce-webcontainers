/** The launcher page's "Copy diagnostics" report: everything the page holds, as plain text. */
import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, type DiagnosticsState } from '../../src/launcher/page/diagnosticsReport.js';

const base = (): DiagnosticsState => ({
  now: new Date('2026-11-21T09:00:00.000Z'),
  pageUrl: 'https://localhost:4555/launcher/',
  userAgent: 'TestAgent/1.0',
  header: { name: 'shop', environment: 'local', tier: 'non-production', target: 'browser' },
  status: { text: 'Could not start: api failed', tone: 'error' },
  services: [
    { id: 'api', type: 'application', runtime: 'node', role: 'backend', state: 'failed', port: 8000, restarts: 2, exitCode: 127, error: { serviceId: 'api', phase: 'start', message: 'bfsh: command not found: npm install', exitCode: 127, willRestart: false } },
    { id: 'web', type: 'application', runtime: 'node', role: 'frontend', state: 'running', port: 5173, restarts: 0, url: 'https://p5173.localhost/' },
  ],
  problems: [
    { severity: 'error', kind: 'issue', subject: 'services.api.command', text: 'bad command' },
    { severity: 'warning', kind: 'declined', subject: 'cache', text: 'redis is not hosted' },
  ],
  logs: {
    lines: [
      { serviceId: 'web', source: 'output', text: 'vite ready' },
      { serviceId: 'api', source: 'runtime', text: 'exited 127' },
    ],
    dropped: 3,
  },
});

describe('buildDiagnosticsReport', () => {
  it('holds the time, page, agent, application, start error, every service, every issue and every log line of every service', () => {
    const report = buildDiagnosticsReport(base());
    expect(report).toContain('Time: 2026-11-21T09:00:00.000Z');
    expect(report).toContain('Page: https://localhost:4555/launcher/');
    expect(report).toContain('User agent: TestAgent/1.0');
    expect(report).toContain('Name: shop');
    expect(report).toContain('Environment: local');
    expect(report).toContain('Target: browser');
    expect(report).toContain('Production: no');
    expect(report).toContain('Start error: Could not start: api failed');
    expect(report).toContain('- api runtime=node state=failed port=8000 restarts=2 exit=127');
    expect(report).toContain('failure (start, exit 127): bfsh: command not found: npm install');
    expect(report).toContain('- web runtime=node state=running port=5173 restarts=0 url=https://p5173.localhost/');
    expect(report).toContain('- [error] services.api.command: bad command');
    expect(report).toContain('- [declined] cache: redis is not hosted');
    expect(report).toContain('## Logs (2 lines, 3 earlier lines dropped)');
    expect(report).toContain('[web] vite ready');
    expect(report).toContain('[api] (runtime) exited 127');
  });

  it('says what is missing before the launch answered, with no error, services, issues or logs', () => {
    const report = buildDiagnosticsReport({ ...base(), header: null, status: { text: 'Loading the project…', tone: 'busy' }, services: [], problems: [], logs: { lines: [], dropped: 0 } });
    expect(report).toContain('Name: (unknown)');
    expect(report).toContain('Production: (unknown)');
    expect(report).toContain('Start error: (none)');
    expect(report).toMatch(/## Services \(0\)\n\(none\)/);
    expect(report).toMatch(/## Issues and declines \(0\)\n\(none\)/);
    expect(report).toMatch(/## Logs \(0 lines\)\n\(no output\)/);
  });

  it('opens with a review warning and redacts credentials on every line, logs and errors alike', () => {
    const state = base();
    state.logs = { lines: [{ serviceId: 'api', source: 'output', text: 'connecting to postgres://app:s3cret@db:5432/app with Authorization: Bearer abc.def' }], dropped: 0 };
    state.services = [{ ...state.services[0]!, error: { serviceId: 'api', phase: 'start', message: 'fetch https://bot:tok123@git.example/x failed; api_key=K9', willRestart: true } }];
    const report = buildDiagnosticsReport(state);
    expect(report.split('\n')[1]).toMatch(/^Review before sharing: logs may contain secrets/);
    expect(report).not.toMatch(/s3cret|tok123|abc\.def|K9/);
    expect(report).toContain('postgres://[redacted]@db:5432/app');
    expect(report).toContain('https://[redacted]@git.example/x');
    expect(report).toContain('Bearer [redacted]');
    expect(report).toContain('api_key=[redacted]');
  });

  it('marks a production environment and carries a blocked launch summary', () => {
    const report = buildDiagnosticsReport({ ...base(), header: { name: 'shop', environment: 'prod', tier: 'production', target: 'cloudflare' }, summary: 'builderforce.json has errors, so nothing was started.' });
    expect(report).toContain('Production: yes');
    expect(report).toContain('Summary: builderforce.json has errors, so nothing was started.');
  });
});
