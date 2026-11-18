/**
 * The Security Shield's event contract (make.md › PRD 31 §4 W10, the Contract
 * paragraph and design decision 9): what a page-side chokepoint reports when it
 * decides, and the `SecurityEventSink` port the embedding product receives
 * those reports through. The runtime emits reason codes only; the product maps
 * them to localized copy and its own security records.
 *
 * Evidence is redacted and bounded HERE, before an event exists: flat scalars
 * only (never a body, a buffer or an object), no key that names a secret
 * (passwords, tokens, cookies, authorization, credentials, sessions, bodies),
 * credentials scrubbed out of URL-like strings and `Bearer` values, every
 * string capped, and the whole of it at most {@link MAX_EVIDENCE_BYTES}.
 */
import type { SecurityContext, ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';

export type SecurityEventCategory = 'ingress' | 'network' | 'process' | 'filesystem' | 'database' | 'resource';
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';
export type SecurityAction = 'allow' | 'monitor' | 'throttle' | 'reject' | 'quarantine';

export type EvidenceValue = string | number | boolean | null;
/** Redacted, bounded facts about one decision (see {@link redactEvidence}). */
export type SecurityEvidence = Readonly<Record<string, EvidenceValue>>;

export interface SecurityEvent {
  readonly category: SecurityEventCategory;
  /** The rule that decided (stable, e.g. `network.service-graph`). */
  readonly ruleId: string;
  readonly severity: SecuritySeverity;
  readonly reasonCode: ShieldReasonCode;
  readonly action: SecurityAction;
  /** Who it concerns, from the page's own record (the Worker or port the traffic arrived on) — never a value a message claimed. */
  readonly context: SecurityContext;
  readonly evidence: SecurityEvidence;
  /** Epoch ms. */
  readonly occurredAt: number;
}

/** Where shield events leave the runtime. Called synchronously, never awaited; whatever it throws (or rejects with) is swallowed. */
export interface SecurityEventSink {
  emit(event: SecurityEvent): void;
}

/** Enforcement and telemetry health, reported separately (principle 6): a failing sink never turns enforcement off. */
export interface SecurityHealth {
  /** The page-side chokepoints decide synchronously in the request path; `held` is reserved for an engine that must hold protected traffic. */
  readonly enforcement: 'ok' | 'held';
  /** `degraded` while the sink's last delivery failed; the in-memory ring keeps every event either way. */
  readonly telemetry: 'ok' | 'degraded';
  /** Deliveries the sink failed since the runtime started. */
  readonly sinkFailures: number;
}

/** No decision has a known owner (a connection the registry named no caller for). Never minted for a process. */
export const UNATTRIBUTED_CONTEXT: SecurityContext = Object.freeze({ applicationId: 'unattributed', serviceId: 'unattributed' });

/** An application as a whole (a decision about its preview origin, not one service of it). */
export function applicationContext(applicationId: string): SecurityContext {
  return Object.freeze({ applicationId, serviceId: UNATTRIBUTED_CONTEXT.serviceId });
}

export const MAX_EVIDENCE_BYTES = 4096;
/** Longest string kept in evidence, in UTF-16 units. */
export const MAX_EVIDENCE_STRING = 512;

/** Keys whose values are never kept: secrets and payloads. */
const SECRET_KEY = /pass(?:word|wd|phrase)?|secret|token|cookie|authori[sz]ation|credential|api[-_]?key|session|bearer|private[-_]?key|^body$|payload|content$/i;
const encoder = new TextEncoder();

/** A string with credentials scrubbed (URL user info, `Bearer`/`Basic` values, `key=value` secrets) and capped. */
export function scrubString(value: string): string {
  let text = value.length > MAX_EVIDENCE_STRING * 2 ? value.slice(0, MAX_EVIDENCE_STRING * 2) : value;
  text = text
    .replace(/(\/\/)[^/@\s]*@/g, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b((?:pass(?:word)?|pwd|token|secret|api[-_]?key|access[-_]?key|session(?:id)?)\s*[=:]\s*)[^\s&;,]+/gi, '$1[redacted]');
  return text.length > MAX_EVIDENCE_STRING ? `${text.slice(0, MAX_EVIDENCE_STRING - 1)}…` : text;
}

/**
 * Keep only what may leave the runtime: scalar values under non-secret keys,
 * scrubbed, at most {@link MAX_EVIDENCE_BYTES} as JSON. Anything else (objects,
 * byte arrays, functions) is dropped, never stringified. `truncated: true`
 * marks evidence cut to fit.
 */
export function redactEvidence(input?: Readonly<Record<string, unknown>>): SecurityEvidence {
  const out: Record<string, EvidenceValue> = {};
  if (!input) return Object.freeze(out);
  // `{}` plus room for `,"truncated":true`.
  const budget = MAX_EVIDENCE_BYTES - 2 - 20;
  let used = 0;
  for (const [rawKey, raw] of Object.entries(input)) {
    if (SECRET_KEY.test(rawKey)) continue;
    let value: EvidenceValue;
    if (raw === null || typeof raw === 'boolean') value = raw;
    else if (typeof raw === 'number') value = Number.isFinite(raw) ? raw : String(raw);
    else if (typeof raw === 'string') value = scrubString(raw);
    else continue;
    const key = scrubString(rawKey).slice(0, 64);
    const size = encoder.encode(JSON.stringify(key)).length + 1 + encoder.encode(JSON.stringify(value)).length + (used ? 1 : 0);
    if (used + size > budget) {
      out.truncated = true;
      break;
    }
    out[key] = value;
    used += size;
  }
  return Object.freeze(out);
}
