import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BatchSyncLog } from '../entities/batch-sync-log.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { ReconResolution } from '../entities/enums';
import {
  BalanceLockService,
  balanceKey,
} from '../common/lock/balance-lock.service';
import { BalanceService } from '../balance/balance.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';
import { BatchCorpus, HcmBalance } from '../hcm/contracts/hcm.types';

/**
 * ReconciliationService — batch ingest and per-balance reconciliation.
 *
 * ADR-009: Reject any batch with sequence <= last applied (STALE_REJECTED).
 * ADR-003: For each balance in the corpus, delegate to BalanceService.reconcileBalance
 *          which implements the full HCM-base + replay-by-hcmAckAt algorithm.
 * ADR-010: Each balance reconcile acquires the per-balance-key lock to serialise
 *          against approve, dispatcher, reaper, and retry workers.
 *
 * Transaction boundary strategy (three separate transactions, not one big one):
 *
 *   Tx-1 (sequence guard) — reads the last BatchSyncLog and optionally writes a
 *   STALE_REJECTED event. Kept as its own transaction so that the stale-rejection
 *   audit row is durable even if a later phase fails, and so the lock on the
 *   BatchSyncLog table is held for the minimum possible time.
 *
 *   Tx-2 per balance (per-balance reconcile) — each balance entry gets its own
 *   transaction inside the per-balance-key lock. This matches ADR-010: different
 *   balances are independent and should run concurrently (loop is sequential here
 *   but each has its own lock acquisition). Keeping them separate means a single
 *   bad balance doesn't roll back the whole batch; it surfaces and can be retried.
 *
 *   Tx-3 (batch log write) — records the sequence as applied only AFTER all
 *   per-balance work is done. If any per-balance reconcile throws, this write
 *   never happens and the next re-delivery of the same batch will not be rejected
 *   as stale — it will retry all entries. This is the safest failure mode: prefer
 *   to reconcile twice (idempotent by design) over silently skipping a balance.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly balanceService: BalanceService,
    private readonly lockService: BalanceLockService,
    @Inject(CLOCK)
    private readonly clock: Clock,
  ) {}

  /**
   * Ingest a full batch corpus pushed by HCM.
   *
   * Algorithm:
   *  1. Sequence guard (ADR-009): in its own transaction, check the last applied
   *     sequence. If corpus.sequence <= last, write a single STALE_REJECTED event
   *     with sentinel employeeId='*' / locationId='*' (documented below) and return.
   *  2. Per-balance reconcile (ADR-003): for each entry, acquire the per-balance-key
   *     lock and delegate to BalanceService.reconcileBalance in its own transaction.
   *  3. Record the batch as applied in a final transaction.
   *
   * STALE sentinel rationale:
   *   E13 says "log STALE_REJECTED and return — no per-balance work, no BatchSyncLog
   *   write". A ReconciliationEvent requires an (employeeId, locationId) pair, but
   *   the rejection is corpus-level, not per-balance. Using sentinel '*' / '*' records
   *   the rejection as a single audit row without implying any particular employee or
   *   location was affected. It is clearly distinguishable from real entries (which
   *   never have '*' in these fields) and avoids iterating all balances just to log
   *   N identical STALE_REJECTED rows.
   *
   * @param corpus  The validated batch payload from the HTTP boundary (§8/ADR-009).
   */
  async ingestBatch(corpus: BatchCorpus): Promise<void> {
    // --- Tx-1: Sequence guard ---
    const isStale = await this.dataSource.transaction(async (manager) => {
      const last = await manager.findOne(BatchSyncLog, {
        order: { sequence: 'DESC' },
        where: {},
      });

      if (last !== null && corpus.sequence <= last.sequence) {
        // E13: stale or out-of-order batch — log once with sentinel identifiers and reject.
        // Sentinel '*' signals a corpus-level rejection, not a per-employee event.
        const event = manager.create(ReconciliationEvent, {
          employeeId: '*',
          locationId: '*',
          localValue: 0,
          hcmValue: 0,
          resolution: ReconResolution.STALE_REJECTED,
        });
        await manager.save(ReconciliationEvent, event);

        this.logger.warn(
          `Stale batch rejected: received sequence=${corpus.sequence}, last applied=${last.sequence}`,
        );
        return true; // stale
      }

      return false; // proceed
    });

    if (isStale) {
      return;
    }

    // --- Tx-2 per balance: reconcile each entry under its own lock + transaction ---
    const asOfDate = new Date(corpus.asOf);

    for (const entry of corpus.balances) {
      const key = balanceKey(entry.employeeId, entry.locationId);

      await this.lockService.runExclusive(key, async () => {
        await this.dataSource.transaction(async (manager) => {
          await this.balanceService.reconcileBalance(entry, asOfDate, manager);
        });
      });
    }

    // --- Tx-3: Record this batch as applied ---
    await this.dataSource.transaction(async (manager) => {
      const logEntry = manager.create(BatchSyncLog, {
        sequence: corpus.sequence,
        asOf: asOfDate,
        // appliedAt is @CreateDateColumn — set automatically by TypeORM.
      });
      await manager.save(BatchSyncLog, logEntry);
    });
  }

  /**
   * Public-API wrapper for a single-balance manual/controller-triggered reconcile.
   *
   * Builds an HcmBalance shaped object from the loose parameters, acquires the
   * per-balance-key lock, and delegates to BalanceService.reconcileBalance (which
   * owns the full ADR-003 algorithm). ADR-010 is satisfied by the lock here; the
   * caller does not need to hold it.
   *
   * @param employeeId
   * @param locationId
   * @param hcmValue   Balance from the HCM snapshot.
   * @param asOf       Snapshot timestamp (ADR-003 replay cutoff).
   */
  async reconcileBalance(
    employeeId: string,
    locationId: string,
    hcmValue: number,
    asOf: Date,
  ): Promise<void> {
    const hcmEntry: HcmBalance = {
      employeeId,
      locationId,
      balance: hcmValue,
      asOf: asOf.toISOString(),
    };

    const key = balanceKey(employeeId, locationId);

    await this.lockService.runExclusive(key, async () => {
      await this.dataSource.transaction(async (manager) => {
        await this.balanceService.reconcileBalance(hcmEntry, asOf, manager);
      });
    });
  }
}
