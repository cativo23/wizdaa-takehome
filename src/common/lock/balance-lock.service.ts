import { Injectable } from '@nestjs/common';

/**
 * Latch handle returned by `installLatch` for test use.
 *
 * - `reached`: a Promise that resolves when the fn under test enters the
 *   critical section and hits the latch (i.e., is now "inside" the lock).
 * - `release()`: call this to let the blocked fn proceed past the latch.
 *
 * @example
 * ```ts
 * const latch = lockService.installLatch('emp1::loc1');
 *
 * // Start A — it will enter the lock and pause at the latch
 * const promiseA = lockService.runExclusive('emp1::loc1', async () => {
 *   // ... work done after latch is released
 * });
 *
 * // Wait until A is inside the critical section
 * await latch.reached;
 *
 * // Fire B — it should be blocked because A holds the lock
 * let bDone = false;
 * const promiseB = lockService.runExclusive('emp1::loc1', async () => {
 *   bDone = true;
 * });
 *
 * // Assert B is not yet done
 * expect(bDone).toBe(false);
 *
 * // Let A proceed
 * latch.release();
 * await promiseA;
 * await promiseB;
 * expect(bDone).toBe(true);
 * ```
 */
export interface LatchHandle {
  /** Resolves when the running fn has entered the critical section. */
  reached: Promise<void>;
  /** Releases the latch, allowing the fn to continue. */
  release(): void;
}

/**
 * BalanceLockService — per-balance-key serialization (ADR-010).
 *
 * All five actors that mutate a balance (approve, retry worker, reconciliation,
 * outbox dispatcher, reservation reaper) must call `runExclusive` with the
 * canonical key for the (employeeId, locationId) pair.
 *
 * Internally, the lock is a Map<string, Promise<void>> — each entry is the
 * tail of a promise chain for that key. A new caller appends to the chain;
 * different keys are fully concurrent.
 *
 * ## Test seam (§9.1)
 *
 * `installLatch(key)` installs a one-shot barrier on `key`.  The next call to
 * `runExclusive(key, fn)` will:
 *   1. Enter the lock (blocking any subsequent caller on the same key).
 *   2. Signal `latch.reached` — the test can now assert the second caller
 *      is blocked.
 *   3. Await `latch.release()` before proceeding with `fn`.
 *
 * In production no latch is installed, so the code path is a straight
 * `await fn()`.  Latches are one-shot and automatically cleared after use.
 */
@Injectable()
export class BalanceLockService {
  /** Tail of the promise chain per key. Absence = no pending work. */
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Pending latch per key (test seam only).
   * Cleared immediately after use so subsequent calls run normally.
   */
  private readonly latches = new Map<
    string,
    {
      reachedResolve: () => void;
      gate: Promise<void>;
    }
  >();

  /**
   * Run `fn` exclusively for `key`.  Concurrent calls on the same key are
   * serialized; calls on different keys run concurrently.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Capture the current tail so we append after it
    const prev = this.chains.get(key) ?? Promise.resolve();

    let resolveMyTurn!: () => void;
    const myTurn = new Promise<void>((res) => {
      resolveMyTurn = res;
    });

    // Register our slot in the chain BEFORE awaiting prev
    this.chains.set(key, myTurn);

    // Wait for all previous work on this key to finish
    await prev;

    // --- Critical section entry ---

    // Test seam: if a latch is installed, signal "reached" then wait for release
    const latch = this.latches.get(key);
    if (latch) {
      this.latches.delete(key); // one-shot
      latch.reachedResolve();
      await latch.gate;
    }

    let result: T;
    try {
      result = await fn();
    } finally {
      // If our slot is still the tail (no new waiter arrived), clean up the key
      if (this.chains.get(key) === myTurn) {
        this.chains.delete(key);
      }
      resolveMyTurn();
    }

    return result;
  }

  /**
   * TEST-ONLY: Install a one-shot latch on `key`.
   *
   * The next `runExclusive(key, ...)` call will pause at the top of the
   * critical section, signal `handle.reached`, then wait for `handle.release()`.
   *
   * @example See the LatchHandle JSDoc above for full usage.
   */
  installLatch(key: string): LatchHandle {
    let reachedResolve!: () => void;
    const reached = new Promise<void>((res) => {
      reachedResolve = res;
    });

    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });

    this.latches.set(key, { reachedResolve, gate });

    return { reached, release: gateResolve };
  }
}

/**
 * Build the canonical balance key for a (employeeId, locationId) pair.
 * All five actors must use this helper — never construct the key ad hoc.
 */
export function balanceKey(employeeId: string, locationId: string): string {
  return `${employeeId}::${locationId}`;
}
