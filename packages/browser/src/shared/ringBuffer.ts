/** A fixed-size history: the newest `capacity` entries, oldest first. Shared by the service logs and the Security Shield's event ring. */
export interface RingBuffer<T> extends Iterable<T> {
  push(item: T): void;
  readonly size: number;
}

export function ringBuffer<T>(capacity: number): RingBuffer<T> {
  const items: T[] = [];
  let start = 0;
  return {
    push(item: T) {
      if (items.length < capacity) items.push(item);
      else {
        items[start] = item;
        start = (start + 1) % capacity;
      }
    },
    get size() {
      return items.length;
    },
    *[Symbol.iterator]() {
      for (let i = 0; i < items.length; i++) yield items[(start + i) % items.length]!;
    },
  };
}
