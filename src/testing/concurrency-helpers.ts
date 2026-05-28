/**
 * Concurrency helpers — thin wrappers over the balance-lock seam and the
 * scheduler-dormant worker services.
 *
 * These helpers exist because:
 *   1. ScheduleModule.forRoot() is NOT imported in the test module, so the
 *      @Cron and @Interval decorators on the dispatcher and reaper never fire
 *      automatically. Tests must call dispatchPending() / sweep() directly.
 *   2. The installLatch seam on BalanceLockService has verbose setup; a thin
 *      wrapper gives test files a one-liner.
 *
 * Usage:
 *
 *   // --- Lock latch (deterministic concurrency, E2/E12/E21) ---
 *   const lockService = moduleRef.get(BalanceLockService);
 *   const latch = withLockLatch(lockService, 'emp1', 'loc1');
 *
 *   const promiseA = lockService.runExclusive(balanceKey('emp1', 'loc1'), async () => {
 *     // work here runs AFTER latch.release() is called
 *   });
 *
 *   await latch.reached;            // A is now inside the critical section
 *   // assert that B is still blocked ...
 *   latch.release();                // let A continue
 *   await promiseA;
 *
 *   // --- Manual worker drive ---
 *   const dispatcher = moduleRef.get(OutboxDispatcherService);
 *   await runDispatcherOnce(dispatcher);
 *
 *   const reaper = moduleRef.get(ReservationReaperService);
 *   await runReaperOnce(reaper);
 */

import { BalanceLockService, balanceKey, LatchHandle } from '../common/lock/balance-lock.service';
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { ReservationReaperService } from '../reservation-reaper/reservation-reaper.service';

/**
 * Install a one-shot latch on the balance key for (employeeId, locationId).
 *
 * Returns the LatchHandle:
 *   - `reached`: Promise that resolves once the next runExclusive call on this
 *     key has entered the critical section (and is now paused at the latch).
 *   - `release()`: Call to let the paused function proceed.
 *
 * See CONTRACTS.md §8 for the full usage example and caveats (latches are
 * one-shot; install a fresh latch for each concurrency assertion).
 */
export function withLockLatch(
  lockService: BalanceLockService,
  employeeId: string,
  locationId: string,
): LatchHandle {
  return lockService.installLatch(balanceKey(employeeId, locationId));
}

/**
 * Manually drive one full pass of the outbox dispatcher.
 *
 * Equivalent to the @Interval(5000) tick firing once.  Use this in tests
 * instead of waiting for the real scheduler (which is dormant).
 */
export async function runDispatcherOnce(
  dispatcher: OutboxDispatcherService,
): Promise<void> {
  await dispatcher.dispatchPending();
}

/**
 * Manually drive one full pass of the reservation reaper.
 *
 * Equivalent to the @Cron(EVERY_5_MINUTES) tick firing once.  Advance the
 * FakeClock past the TTL before calling this to trigger expiries:
 *
 *   clock.advance(15 * 24 * 60 * 60 * 1000);  // past 14-day TTL
 *   await runReaperOnce(reaper);
 */
export async function runReaperOnce(
  reaper: ReservationReaperService,
): Promise<void> {
  await reaper.sweep();
}
