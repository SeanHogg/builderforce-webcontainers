/**
 * `@seanhogg/builderforce-webcontainers/security` — the Security Shield's
 * contract (make.md › PRD 31 §4 W10): the `SecurityEvent` schema, the
 * `SecurityEventSink` port events leave through, the telemetry the runtime
 * builds once (`createShieldTelemetry`: bounded event ring, enforcement and
 * telemetry health) and the reason-code rule table. Re-exports the identity
 * half from core (`SecurityContext`, `ShieldReasonCode`, `ShieldDecision`).
 */
export * from './security/index.js';
export { ALLOW, deny, PLATFORM_CONTEXT, WORKSPACE_CONTEXT, PLATFORM_APPLICATION, WORKSPACE_APPLICATION, sameService } from '@seanhogg/builderforce-webcontainers-core';
export type { SecurityContext, ShieldDecision, ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
