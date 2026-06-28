/**
 * Promise-based semaphore factory for limiting concurrent async operations.
 *
 * Used by avatarService and mediaDownloadService to prevent unbounded
 * concurrent crypto/download operations that would starve the JS thread.
 */

export function createSemaphore(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active++;
        resolve();
      });
    });
  }

  function release(): void {
    if (active > 0) active--;
    const next = queue.shift();
    if (next) next();
  }

  /** Reset all state. Callers blocked in acquire() will never resolve —
   *  only safe during session teardown (logout/wipe). */
  function reset(): void {
    active = 0;
    queue.length = 0;
  }

  return { acquire, release, reset };
}
