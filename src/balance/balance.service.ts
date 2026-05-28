import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  OptimisticLockVersionMismatchError,
  EntityManager,
} from 'typeorm';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { HcmBalance } from '../hcm/contracts/hcm.types';
import type { HcmClient } from '../hcm/contracts/hcm-client.interface';
import { HCM_CLIENT } from '../hcm/hcm.tokens';
import { HcmUnavailableError } from '../hcm/hcm.errors';
import {
  BalanceLockService,
  balanceKey,
} from '../common/lock/balance-lock.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';
import { AppConfigService } from '../config/app-config.service';
import {
  RequestStatus,
  OutboxOperation,
  OutboxStatus,
  ReconResolution,
} from '../entities/enums';

/** Balance augmented with an optional ephemeral degraded flag (ADR-014). */
type BalanceWithDegraded = Balance & { degraded?: boolean };

/** Max number of optimistic-lock retries before we give up. */
const MAX_OPTIMISTIC_RETRIES = 5;

/**
 * BalanceService — all balance-level reads and mutations.
 *
 * Every method that mutates a balance MUST be called under the balance-key
 * lock (ADR-010). The lock is acquired by the calling service (e.g.,
 * TimeOffRequestService at submit/approve, ReconciliationService at ingest)
 * so BalanceService methods can be composed inside a single lock acquisition.
 *
 * The only exception is `getBalance` (read-only) — it doesn't need the lock.
 * `resolveReview` acquires the lock itself because it is called directly from
 * the controller with no outer lock holder.
 */
@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Outbox)
    private readonly outboxRepo: Repository<Outbox>,
    @InjectRepository(ReconciliationEvent)
    private readonly reconEventRepo: Repository<ReconciliationEvent>,
    private readonly lockService: BalanceLockService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly appConfig: AppConfigService,
    @Inject(HCM_CLIENT)
    private readonly hcmClient: HcmClient,
  ) {}

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Load a balance row for (employeeId, locationId), creating a zero record if
   * none exists. Does NOT save the newly-created row — callers that mutate must
   * save explicitly.
   */
  private async findOrCreate(
    employeeId: string,
    locationId: string,
    manager?: EntityManager,
  ): Promise<Balance> {
    const repo = manager ? manager.getRepository(Balance) : this.balanceRepo;
    const existing = await repo.findOne({
      where: { employeeId, locationId },
    });
    if (existing) return existing;

    const fresh = this.balanceRepo.create({
      employeeId,
      locationId,
      available: 0,
      reserved: 0,
      needsReview: false,
      lastHcmAsOf: null,
    });
    return fresh;
  }

  /**
   * Save a Balance row with optimistic-lock retry.
   * On OptimisticLockVersionMismatchError, reload from DB and re-apply the
   * mutation callback, up to MAX_OPTIMISTIC_RETRIES times.
   *
   * @param balance   The entity loaded before mutation.
   * @param mutate    A function that applies the desired mutation to a Balance
   *                  instance in-place. It will be called again on each retry
   *                  with a freshly reloaded copy.
   */
  private async saveWithRetry(
    balance: Balance,
    mutate: (b: Balance) => void,
    manager?: EntityManager,
  ): Promise<void> {
    let current = balance;
    mutate(current);

    for (let attempt = 0; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
      try {
        if (manager) {
          await manager.save(Balance, current);
        } else {
          await this.balanceRepo.save(current);
        }
        return;
      } catch (err) {
        if (
          err instanceof OptimisticLockVersionMismatchError ||
          (err instanceof Error &&
            err.message.includes('OptimisticLockVersionMismatchError'))
        ) {
          if (attempt === MAX_OPTIMISTIC_RETRIES) {
            throw err; // Exhaust retries — propagate
          }
          // Reload and re-apply mutation
          const repo = manager
            ? manager.getRepository(Balance)
            : this.balanceRepo;
          const reloaded = await repo.findOne({
            where: {
              employeeId: balance.employeeId,
              locationId: balance.locationId,
            },
          });
          if (!reloaded) {
            throw new Error(
              `Balance row vanished during retry for ${balance.employeeId}::${balance.locationId}`,
            );
          }
          current = reloaded;
          mutate(current);
        } else {
          throw err;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Read-only: return the current balance for (employeeId, locationId).
   *
   * ADR-014 cold-read lazy hydration:
   *  - Hot path (row exists AND lastHcmAsOf is non-null): return cached row immediately.
   *    No lock, no HCM call.
   *  - Feature-flag off (BALANCE_LAZY_LOAD_ENABLED=false): legacy zero-on-miss behavior.
   *  - Cold path (row absent OR lastHcmAsOf null): acquire the balance-key lock, re-check
   *    the condition (double-checked locking), call HCM once, and persist via
   *    applyHcmSnapshot. On HcmUnavailableError, return an EPHEMERAL DTO with
   *    degraded=true — nothing is persisted so the next call retries the bootstrap.
   *
   * FR-1.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<BalanceWithDegraded> {
    const row = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    // Hot path: cache warm — row exists and has been synced at least once.
    // Must NOT acquire the lock and must NOT call HCM (ADR-014).
    if (row !== null && row.lastHcmAsOf !== null) {
      return row;
    }

    // Feature-flag rollback: legacy zero-on-miss behavior for production rollback.
    if (!this.appConfig.balanceLazyLoadEnabled) {
      if (row !== null) return row;
      const fresh = this.balanceRepo.create({
        employeeId,
        locationId,
        available: 0,
        reserved: 0,
        needsReview: false,
        lastHcmAsOf: null,
      });
      return this.balanceRepo.save(fresh);
    }

    // Cold path: row is absent or lastHcmAsOf is null.
    // Acquire the balance-key lock to prevent stampede (ADR-010).
    return this.lockService.runExclusive(
      balanceKey(employeeId, locationId),
      async () => {
        // Double-checked locking: re-read inside the lock in case another caller
        // already hydrated the row while we were waiting to acquire the lock.
        const fresh = await this.balanceRepo.findOne({
          where: { employeeId, locationId },
        });
        if (fresh !== null && fresh.lastHcmAsOf !== null) {
          return fresh; // Another caller already hydrated. Cache warm now.
        }

        // Still cold — perform a single HCM read.
        // Pass retry:false so a down HCM degrades fast (≤2.5 s) instead of
        // burning the full 31-second retry budget. The caller has a graceful
        // local fallback (ephemeral degraded DTO — ADR-014).
        let snapshot;
        try {
          snapshot = await this.hcmClient.getBalance(employeeId, locationId, {
            retry: false,
          });
        } catch (err) {
          if (err instanceof HcmUnavailableError) {
            // CRITICAL: do NOT persist anything. Return an ephemeral DTO so the
            // next request retries the cold-load (no cached wrong answer — ADR-014).
            const now = this.clock.now();
            const ephemeral = Object.assign(new Balance(), {
              employeeId,
              locationId,
              available: 0,
              reserved: 0,
              needsReview: false,
              version: 0,
              lastHcmAsOf: null,
              createdAt: now,
              updatedAt: now,
              degraded: true,
            }) as BalanceWithDegraded;
            return ephemeral;
          }
          throw err;
        }

        // Success — persist the snapshot via the existing applyHcmSnapshot path.
        // Caller already holds the lock so this is safe (no re-entrancy issue).
        await this.applyHcmSnapshot(snapshot);
        return (await this.balanceRepo.findOne({
          where: { employeeId, locationId },
        })) as Balance;
      },
    );
  }

  /**
   * Validate that `days` are available for (employeeId, locationId).
   * Used for instant feedback at submit (ADR-001 local guard).
   * Does NOT mutate state.
   *
   * @throws ConflictException when available < days.
   */
  async validateAvailability(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<void> {
    const balance = await this.getBalance(employeeId, locationId);
    const free = balance.available - balance.reserved;
    if (free < days) {
      throw new ConflictException(
        `Insufficient balance: requested ${days} days but only ${free} available (${balance.available} total minus ${balance.reserved} reserved)`,
      );
    }
  }

  /**
   * Reserve `days` on submit: available -= days, reserved += days.
   * Called inside the balance-key lock by TimeOffRequestService.submit.
   * ADR-002.
   *
   * @throws ConflictException if available < days (double-check under lock).
   */
  async reserve(
    employeeId: string,
    locationId: string,
    days: number,
    manager?: EntityManager,
  ): Promise<void> {
    const balance = await this.findOrCreate(employeeId, locationId, manager);

    // Double-check under lock — the pre-lock check at submit is advisory only.
    // Available capacity is available minus already-reserved days (A1 fix).
    const free = balance.available - balance.reserved;
    if (free < days) {
      throw new ConflictException(
        `Insufficient balance: requested ${days} days but only ${free} available (${balance.available} total minus ${balance.reserved} reserved)`,
      );
    }

    // A1/A2 fix: reserve only increments reserved; available is NOT decremented here.
    // available is only reduced at commit time (approve path).
    await this.saveWithRetry(
      balance,
      (b) => {
        b.reserved += days;
      },
      manager,
    );
  }

  /**
   * Release a reservation: reserved -= days (floored at 0 defensively).
   * Called on REJECTED, EXPIRED, and cancel of a PENDING/PENDING_SYNC request.
   * Does NOT touch `available` — the days were never committed.
   * Called inside the balance-key lock.
   */
  async release(
    employeeId: string,
    locationId: string,
    days: number,
    manager?: EntityManager,
  ): Promise<void> {
    const balance = await this.findOrCreate(employeeId, locationId, manager);

    await this.saveWithRetry(
      balance,
      (b) => {
        b.reserved = Math.max(0, b.reserved - days);
      },
      manager,
    );
  }

  /**
   * Commit an approved request: available -= days, reserved -= days.
   * Called inside the balance-key lock by the approve path (ADR-001 step 4).
   */
  async commit(
    employeeId: string,
    locationId: string,
    days: number,
    manager?: EntityManager,
  ): Promise<void> {
    const balance = await this.findOrCreate(employeeId, locationId, manager);

    await this.saveWithRetry(
      balance,
      (b) => {
        b.available -= days;
        b.reserved = Math.max(0, b.reserved - days);
      },
      manager,
    );
  }

  /**
   * Restore balance on cancel of an APPROVED request: available += days.
   * Called inside the balance-key lock by TimeOffRequestService.cancel.
   */
  async restore(
    employeeId: string,
    locationId: string,
    days: number,
    manager?: EntityManager,
  ): Promise<void> {
    const balance = await this.findOrCreate(employeeId, locationId, manager);

    await this.saveWithRetry(
      balance,
      (b) => {
        b.available += days;
      },
      manager,
    );
  }

  /**
   * Apply a fresh HCM realtime balance snapshot (ADR-001 step 2).
   * Sets Balance.available = snapshot.balance, Balance.lastHcmAsOf = snapshot.asOf.
   * Called inside the balance-key lock during the approve sequence.
   * Does NOT touch `reserved`.
   */
  async applyHcmSnapshot(
    snapshot: HcmBalance,
    manager?: EntityManager,
  ): Promise<void> {
    const balance = await this.findOrCreate(
      snapshot.employeeId,
      snapshot.locationId,
      manager,
    );

    await this.saveWithRetry(
      balance,
      (b) => {
        b.available = snapshot.balance;
        b.lastHcmAsOf = new Date(snapshot.asOf);
      },
      manager,
    );
  }

  /**
   * Reconcile a balance against an HCM batch entry (ADR-003).
   *
   * Algorithm:
   * 1. base available = hcmValue from the snapshot.
   * 2. Find all APPROVED requests for (emp, loc) where hcmAckAt IS NULL OR
   *    hcmAckAt > asOf — these are committed locally but the FILE had not yet
   *    been acknowledged by HCM at snapshot time, so the snapshot balance does
   *    NOT include them. Subtract their `days` (the local deduction must be
   *    re-applied on top of the HCM base).
   * 3. Find all PENDING REVERSE outbox rows for (emp, loc) where the linked
   *    request is CANCELLED — these are reversal operations the snapshot cannot
   *    reflect yet. Add back their `days` (the reversal will increase the HCM
   *    balance, so we credit locally too).
   * 4. reserved stays as the local sum of PENDING + PENDING_SYNC requests (HCM
   *    knows nothing about reservations).
   * 5. Set lastHcmAsOf = asOf.
   * 6. If available < 0 → set needsReview = true, emit FLAGGED_NEGATIVE event.
   *    Otherwise emit REPLAYED (adjustments were made) or NO_CHANGE (nothing differed).
   *
   * Called inside the balance-key lock by ReconciliationService.
   */
  async reconcileBalance(
    hcmEntry: HcmBalance,
    asOf: Date,
    manager?: EntityManager,
  ): Promise<void> {
    const { employeeId, locationId, balance: hcmValue } = hcmEntry;

    const requestRepo = manager
      ? manager.getRepository(TimeOffRequest)
      : this.requestRepo;
    const outboxRepo = manager
      ? manager.getRepository(Outbox)
      : this.outboxRepo;
    const reconEventRepo = manager
      ? manager.getRepository(ReconciliationEvent)
      : this.reconEventRepo;

    const currentBalance = await this.findOrCreate(
      employeeId,
      locationId,
      manager,
    );
    const localValueBefore = currentBalance.available;

    // Step 2 — Requests whose deductions are NOT yet reflected in the HCM snapshot.
    //
    // Under the Pure Outbox approve model, committing an approval moves the request to
    // PENDING_SYNC and sets committedAt. The OutboxDispatcher later sends the FILE to HCM
    // and sets hcmAckAt. Until that ack arrives, the request is PENDING_SYNC and the snapshot
    // DOES NOT include the deduction.
    //
    // Once the dispatcher acks (hcmAckAt IS NOT NULL AND <= asOf), the request transitions to
    // APPROVED — the snapshot at asOf already reflects it, so we must NOT re-subtract it.
    //
    // Cases where we MUST re-subtract:
    //   APPROVED with hcmAckAt IS NULL  → FILE never acked (in-flight or never sent)
    //   APPROVED with hcmAckAt > asOf   → FILE acked AFTER the snapshot was taken
    //   PENDING_SYNC (any hcmAckAt)     → committed locally but HCM hasn't acked yet;
    //                                     committedAt is set but hcmAckAt may be null.
    //                                     These ARE committed-but-unacked deductions and
    //                                     must be subtracted from the HCM base (A3 fix).
    const unackedApprovals = await requestRepo
      .createQueryBuilder('r')
      .where('r.employeeId = :employeeId', { employeeId })
      .andWhere('r.locationId = :locationId', { locationId })
      .andWhere('r.status IN (:...statuses)', {
        statuses: [RequestStatus.APPROVED, RequestStatus.PENDING_SYNC],
      })
      .andWhere('(r.hcmAckAt IS NULL OR r.hcmAckAt > :asOf)', {
        asOf: asOf.toISOString(),
      })
      .getMany();

    const unackedDeductionDays = unackedApprovals.reduce(
      (sum, r) => sum + r.days,
      0,
    );

    // Step 3 — Pending REVERSE outbox rows whose linked request is CANCELLED.
    // These represent in-flight cancellations HCM hasn't processed yet.
    // The snapshot balance does NOT include the credit; add it back.
    const pendingReverseOutboxRows = await outboxRepo
      .createQueryBuilder('o')
      .innerJoin(
        TimeOffRequest,
        'r',
        'r.id = o.aggregateId AND r.employeeId = :employeeId AND r.locationId = :locationId',
        { employeeId, locationId },
      )
      .where('o.operation = :op', { op: OutboxOperation.REVERSE })
      .andWhere('o.status = :status', { status: OutboxStatus.PENDING })
      .andWhere('r.status = :reqStatus', {
        reqStatus: RequestStatus.CANCELLED,
      })
      .select(['o.aggregateId', 'r.days'])
      .getRawMany<{ r_days: number }>();
    const pendingReverseDays = pendingReverseOutboxRows.reduce(
      (sum, row) => sum + (row.r_days ?? 0),
      0,
    );

    // Step 4 — Recompute reserved from live PENDING rows ONLY.
    //
    // At PENDING_SYNC, `commit` has already cleared the reserved holding
    // (reserved -= days) and deducted from available. PENDING_SYNC requests
    // must NOT be counted in freshReserved — doing so would double-count the
    // reservation that was already released during commit (A3 fix).
    const activeReservations = await requestRepo
      .createQueryBuilder('r')
      .where('r.employeeId = :employeeId', { employeeId })
      .andWhere('r.locationId = :locationId', { locationId })
      .andWhere('r.status = :status', {
        status: RequestStatus.PENDING,
      })
      .getMany();

    const freshReserved = activeReservations.reduce(
      (sum, r) => sum + r.days,
      0,
    );

    // Step 1 + 2 + 3 → new available
    // base (hcmValue) already includes all HCM-acked approved deductions.
    // Subtract unacked approvals (snapshot misses them).
    // Add pending reversals (snapshot hasn't credited them yet).
    const newAvailable = hcmValue - unackedDeductionDays + pendingReverseDays;

    // Determine resolution before mutating
    const hasAdjustments =
      unackedDeductionDays !== 0 ||
      pendingReverseDays !== 0 ||
      newAvailable !== localValueBefore ||
      freshReserved !== currentBalance.reserved;

    const isNegative = newAvailable < 0;

    // Apply to the balance entity with optimistic-lock retry
    await this.saveWithRetry(
      currentBalance,
      (b) => {
        b.available = newAvailable;
        b.reserved = freshReserved;
        b.lastHcmAsOf = asOf;
        if (isNegative) {
          b.needsReview = true;
        }
      },
      manager,
    );

    // Step 6 — Emit ReconciliationEvent (append-only)
    const resolution: ReconResolution = isNegative
      ? ReconResolution.FLAGGED_NEGATIVE
      : hasAdjustments
        ? ReconResolution.REPLAYED
        : ReconResolution.NO_CHANGE;

    const event = reconEventRepo.create({
      employeeId,
      locationId,
      localValue: localValueBefore,
      hcmValue,
      resolution,
    });
    await reconEventRepo.save(event);
  }

  /**
   * Clear the needsReview flag after manager resolution (ADR-003/B4).
   * Manager-only enforcement is in the controller.
   *
   * This is the ONE method that acquires the balance-key lock itself, because
   * it is called directly by the controller with no outer lock holder.
   */
  async resolveReview(employeeId: string, locationId: string): Promise<void> {
    const key = balanceKey(employeeId, locationId);
    await this.lockService.runExclusive(key, async () => {
      const balance = await this.findOrCreate(employeeId, locationId);
      await this.saveWithRetry(balance, (b) => {
        b.needsReview = false;
      });
    });
  }
}
