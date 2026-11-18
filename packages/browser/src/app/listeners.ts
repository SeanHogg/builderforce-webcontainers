/** A set of listeners: `on` returns the unsubscribe; one throwing listener does not stop the others. */
export interface Listeners<T> {
  on(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

export function createListeners<T>(): Listeners<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
  };
}
