/**
 * The Security Shield's telemetry for one runtime (make.md › PRD 31 §4 W10,
 * principle 6 and design decision 9): the host builds it ONCE
 * (`createShieldTelemetry({ sink })`) and hands it to every page-side
 * chokepoint — the port registry, the process host (quotas, file-system
 * refusals, ingress limits), the database host and the boot/routing checks.
 *
 * Each refusal becomes a {@link SecurityEvent} (rule, category, severity and
 * action from `SHIELD_RULES`), kept in a bounded in-memory ring and handed to
 * the injected {@link SecurityEventSink}. Telemetry fails OPEN: the sink is
 * called synchronously inside try/catch and never awaited (a returned promise's
 * rejection is caught too), so a throwing or slow-to-settle sink never changes a
 * decision or breaks a request. Enforcement never reads anything from here.
 */
import { PLATFORM_CONTEXT, type PortRegistry, type SecurityContext, type ShieldDecision, type ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
import { ringBuffer } from '../shared/ringBuffer.js';
import { SHIELD_RULES } from './shieldRules.js';
import { UNATTRIBUTED_CONTEXT, redactEvidence, type SecurityEvent, type SecurityEventSink, type SecurityHealth } from './securityEvent.js';

/** One port-access decision, as the port registry's `onDecision` reports it. */
export type PortDecision = Parameters<NonNullable<NonNullable<ConstructorParameters<typeof PortRegistry>[0]>['onDecision']>>[0];

/** A boot or routing notice in the shape `previewOrigin.ts`'s `emitShieldEvent` sends (`ShieldEventSink`). */
export interface ShieldNotice {
  reason: ShieldReasonCode;
  message: string;
  applicationId?: string;
  origin?: string;
}

export interface ShieldTelemetryOptions {
  /** Where events leave the runtime (the embedding product's adapter). Optional: the ring keeps them either way. */
  sink?: SecurityEventSink;
  /** Events the in-memory ring keeps (the newest). Default 500. */
  capacity?: number;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
}

export interface ShieldTelemetry {
  /** A chokepoint refused (or noticed) something: `context` is the page-side record of who, `evidence` is redacted here. */
  report(reason: ShieldReasonCode, context: SecurityContext | undefined, evidence?: Readonly<Record<string, unknown>>): void;
  /** A page-side decision: a refusal is reported, an allow is not. */
  decision(context: SecurityContext | undefined, decision: ShieldDecision, evidence?: Readonly<Record<string, unknown>>): void;
  /** The port registry's `onDecision` hook: refusals reported as the (page-side) caller. */
  readonly portDecision: (event: PortDecision) => void;
  /** A `ShieldEventSink` for the boot/routing checks that report `ShieldNotice`s (`checkPreviewOrigins`, `createPreviewOrigins`). */
  readonly notices: { emit(notice: ShieldNotice): void };
  /** The ring's events, oldest first — one application's when `applicationId` is given. A copy. */
  events(filter?: { applicationId?: string }): SecurityEvent[];
  health(): SecurityHealth;
}

export const DEFAULT_EVENT_CAPACITY = 500;

export function createShieldTelemetry(options: ShieldTelemetryOptions = {}): ShieldTelemetry {
  const ring = ringBuffer<SecurityEvent>(Math.max(1, Math.floor(options.capacity ?? DEFAULT_EVENT_CAPACITY)));
  const now = options.now ?? Date.now;
  const sink = options.sink;
  let sinkFailures = 0;
  let lastDeliveryFailed = false;
  const failed = () => {
    sinkFailures += 1;
    lastDeliveryFailed = true;
  };

  const deliver = (event: SecurityEvent) => {
    if (!sink) return;
    try {
      const result = sink.emit(event) as unknown;
      lastDeliveryFailed = false;
      // Never awaited; a sink that returns a promise only gets its rejection caught.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') (result as PromiseLike<unknown>).then(undefined, failed);
    } catch {
      failed();
    }
  };

  const report: ShieldTelemetry['report'] = (reason, context, evidence) => {
    try {
      const rule = SHIELD_RULES[reason];
      if (!rule) return;
      const event: SecurityEvent = Object.freeze({
        category: rule.category,
        ruleId: rule.ruleId,
        severity: rule.severity,
        reasonCode: reason,
        action: rule.action,
        context: Object.freeze({ ...(context ?? UNATTRIBUTED_CONTEXT) }),
        evidence: redactEvidence(evidence),
        occurredAt: now(),
      });
      ring.push(event);
      deliver(event);
    } catch {
      // Telemetry fails open: the decision it describes already stands.
    }
  };

  return {
    report,
    decision: (context, decision, evidence) => {
      if (!decision.allow) report(decision.reason, context, evidence);
    },
    portDecision: ({ operation, port, caller, owner, decision }) => {
      if (!decision.allow) report(decision.reason, caller, { operation, port, ownerApplicationId: owner.applicationId, ownerServiceId: owner.serviceId });
    },
    notices: {
      emit: ({ reason, message, applicationId, origin }) =>
        // Boot and routing checks are the host's own; an application's names that application (no single service).
        report(reason, applicationId === undefined ? PLATFORM_CONTEXT : { applicationId, serviceId: UNATTRIBUTED_CONTEXT.serviceId }, { message, origin: origin ?? null }),
    },
    events: (filter) => [...ring].filter((event) => filter?.applicationId === undefined || event.context.applicationId === filter.applicationId),
    health: () => ({ enforcement: 'ok', telemetry: lastDeliveryFailed ? 'degraded' : 'ok', sinkFailures }),
  };
}
