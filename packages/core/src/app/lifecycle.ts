/**
 * A service's lifecycle as a state machine. The table below is the whole rule:
 * a transition it does not list throws `IllegalTransitionError`.
 *
 *   discovered → preparing → starting → ready → running → stopping → stopped
 *                                                      ↘ failed (from any active state)
 *
 * `stopped` and `failed` start again through `preparing` (a restart).
 */

export type ServiceState = 'discovered' | 'preparing' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed';

export const SERVICE_TRANSITIONS: Readonly<Record<ServiceState, readonly ServiceState[]>> = {
  // `failed` straight from `discovered`: a dependency failed, or no provider accepts it.
  discovered: ['preparing', 'failed'],
  preparing: ['starting', 'stopping', 'failed'],
  starting: ['ready', 'stopping', 'failed'],
  ready: ['running', 'stopping', 'failed'],
  // `stopped` from `running`: a one-off service (readiness `exit-zero`) finished.
  running: ['stopping', 'stopped', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['preparing'],
  failed: ['preparing', 'stopped'],
};

/** States in which the service may have a live process. */
export const ACTIVE_STATES: ReadonlySet<ServiceState> = new Set(['preparing', 'starting', 'ready', 'running']);

export class IllegalTransitionError extends Error {
  constructor(
    readonly serviceId: string,
    readonly from: ServiceState,
    readonly to: ServiceState,
  ) {
    super(`Service "${serviceId}" cannot go from "${from}" to "${to}".`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: ServiceState, to: ServiceState): boolean {
  return SERVICE_TRANSITIONS[from].includes(to);
}

export interface StateChange {
  serviceId: string;
  from: ServiceState;
  to: ServiceState;
}

export interface ServiceLifecycle {
  readonly serviceId: string;
  readonly state: ServiceState;
  /** Move to `to`, or throw `IllegalTransitionError`. */
  transition(to: ServiceState): StateChange;
}

/** One service's lifecycle, starting at `discovered`. */
export function createLifecycle(serviceId: string, onChange?: (change: StateChange) => void): ServiceLifecycle {
  let state: ServiceState = 'discovered';
  return {
    serviceId,
    get state() {
      return state;
    },
    transition(to) {
      if (!canTransition(state, to)) throw new IllegalTransitionError(serviceId, state, to);
      const change = { serviceId, from: state, to };
      state = to;
      onChange?.(change);
      return change;
    },
  };
}
