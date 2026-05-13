/**
 * LRU-evicting Set for WebSocket message deduplication.
 *
 * When a broadcast arrives (new_thread, new_reply), we check the ID against
 * this set to avoid processing duplicates (e.g., the same event arrives
 * via WS after an optimistic HTTP update). Oldest entries are evicted when
 * the set exceeds capacity.
 */

export class LRUSet {
  private readonly capacity: number;
  private readonly set: Set<string>;

  constructor(capacity = 500) {
    this.capacity = capacity;
    this.set = new Set();
  }

  /** Check if the key is in the set. Accessing promotes it to most-recent. */
  has(key: string): boolean {
    if (!this.set.has(key)) {
      return false;
    }
    // Promote to most-recent by re-inserting (Set preserves insertion order)
    this.set.delete(key);
    this.set.add(key);
    return true;
  }

  /** Add a key. Evicts the oldest entry if at capacity. */
  add(key: string): void {
    if (this.set.has(key)) {
      // Promote to most-recent
      this.set.delete(key);
    } else if (this.set.size >= this.capacity) {
      // Evict oldest (first entry in insertion order)
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
    this.set.add(key);
  }

  /** Current number of entries. */
  get size(): number {
    return this.set.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.set.clear();
  }
}
