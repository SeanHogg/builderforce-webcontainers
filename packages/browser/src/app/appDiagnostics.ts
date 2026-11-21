/**
 * `app.diagnostics()`: each service's state with its last log lines, as plain
 * data — what a load or failure report needs from an application without
 * reading every `logs()` stream (ROADMAP item 27, the application half of
 * `runtime.diagnostics()`).
 */
import type { ServiceLogs } from './serviceLogs.js';
import type { ApplicationDiagnostics, ServiceSnapshot } from './types.js';

/** Log lines reported per service: the last ones the log still holds (its history bounds them too). */
export const DIAGNOSTIC_LOG_LINES = 20;

export function applicationDiagnostics(services: readonly ServiceSnapshot[], logs: Pick<ServiceLogs, 'recent'>, lines = DIAGNOSTIC_LOG_LINES): ApplicationDiagnostics {
  return {
    services: services.map((service) => ({
      id: service.id,
      state: service.state,
      ...(service.restarts > 0 ? { restarts: service.restarts } : {}),
      ...(service.exitCode !== undefined ? { lastExitCode: service.exitCode } : {}),
      lastLines: logs.recent(service.id, lines),
    })),
  };
}
