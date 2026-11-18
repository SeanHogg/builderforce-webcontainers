/**
 * The one restart a service may have waiting: scheduled after the policy's
 * backoff, cancelled by a stop. Waiting for the previous process to let go of
 * its port is the launch's job (it waits for the last exit before starting).
 */
export interface RestartScheduler {
  /** A restart is waiting for its backoff to pass. */
  readonly pending: boolean;
  /** Replace any waiting restart with this one. */
  schedule(delayMs: number, launch: () => void): void;
  cancel(): void;
}

export function createRestartScheduler(): RestartScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    get pending() {
      return timer !== undefined;
    },
    schedule(delayMs, launch) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        launch();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
