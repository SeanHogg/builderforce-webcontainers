/**
 * Which rule, category, severity and action each Security Shield reason code
 * stands for. One table, keyed by every `ShieldReasonCode`, so a new reason
 * code does not compile until it says what it means as an event.
 *
 * Every refusal the runtime makes today is a deterministic boundary or
 * protocol violation (principle 5), so its action is `reject`; the one notice
 * that refuses nothing (`ingress.shared_preview_origin`) is `monitor`.
 */
import type { ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
import type { SecurityAction, SecurityEventCategory, SecuritySeverity } from './securityEvent.js';

export interface ShieldRule {
  readonly category: SecurityEventCategory;
  readonly ruleId: string;
  readonly severity: SecuritySeverity;
  readonly action: SecurityAction;
}

const rule = (category: SecurityEventCategory, ruleId: string, severity: SecuritySeverity, action: SecurityAction = 'reject'): ShieldRule => Object.freeze({ category, ruleId, severity, action });

export const SHIELD_RULES: Readonly<Record<ShieldReasonCode, ShieldRule>> = Object.freeze({
  'port.not_owner': rule('network', 'network.port-ownership', 'medium'),
  'port.edge_not_declared': rule('network', 'network.service-graph', 'medium'),
  'db.auth_failed': rule('database', 'database.authentication', 'high'),
  'db.not_owner': rule('database', 'database.ownership', 'high'),
  'db.service_not_allowed': rule('database', 'database.service-graph', 'high'),
  'process.spawn_quota': rule('resource', 'resource.spawn-quota', 'medium'),
  'process.depth_quota': rule('resource', 'resource.depth-quota', 'medium'),
  'fs.outside_app': rule('filesystem', 'filesystem.app-subtree', 'high'),
  'fs.protected_path': rule('filesystem', 'filesystem.protected-path', 'high'),
  'fs.invalid_op': rule('filesystem', 'filesystem.journal-protocol', 'medium'),
  'ingress.body_too_large': rule('ingress', 'ingress.body-limit', 'low'),
  'ingress.client_not_bound': rule('ingress', 'ingress.client-binding', 'high'),
  'ingress.attach_rejected': rule('ingress', 'ingress.attach', 'high'),
  'ingress.same_origin_refused': rule('ingress', 'ingress.origin-separation', 'high'),
  'ingress.preview_origin_invalid': rule('ingress', 'ingress.preview-origin', 'high'),
  'ingress.app_origin_mismatch': rule('ingress', 'ingress.app-origin', 'high'),
  'ingress.shared_preview_origin': rule('ingress', 'ingress.shared-preview-origin', 'low', 'monitor'),
});
