import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BatchSyncLog } from '../entities/batch-sync-log.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { BalanceService } from '../balance/balance.service';
import { BatchCorpus } from '../hcm/contracts/hcm.types';

/**
 * ReconciliationService — batch ingest and per-balance reconciliation.
 *
 * ADR-003: After ordering checks (ADR-009), for each balance entry in the
 * batch: set base = HCM value, replay local effects with hcmAckAt IS NULL
 * OR hcmAckAt > asOf. If result negative → set needsReview (B4).
 *
 * ADR-009: Reject any batch with sequence <= last applied.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @InjectRepository(BatchSyncLog)
    private readonly batchLogRepo: Repository<BatchSyncLog>,
    @InjectRepository(ReconciliationEvent)
    private readonly reconEventRepo: Repository<ReconciliationEvent>,
    private readonly balanceService: BalanceService,
    private readonly lockService: BalanceLockService,
  ) {}

  /**
   * Ingest a full batch corpus. §8/ADR-003/ADR-009.
   *
   * Sequence:
   *   1. Load last applied sequence from BatchSyncLog.
   *   2. If batch.sequence <= last → log STALE_REJECTED event per balance entry → return.
   *   3. For each balance entry, acquire the per-balance-key lock and call
   *      `balanceService.reconcileBalance(entry, asOf)`.
   *   4. Insert BatchSyncLog record for this sequence.
   *
   * @param corpus  The validated batch payload from the HTTP boundary.
   */
  async ingestBatch(corpus: BatchCorpus): Promise<void> {
    throw new Error('NotImplemented: ReconciliationService.ingestBatch');
  }

  /**
   * Reconcile a single balance entry from a batch (ADR-003).
   * Delegates to BalanceService.reconcileBalance after acquiring the lock.
   *
   * Separated from ingestBatch to allow per-balance retry in future phases
   * and to simplify unit testing of individual entries.
   *
   * @param employeeId
   * @param locationId
   * @param hcmValue   - The balance from the HCM snapshot.
   * @param asOf       - The snapshot timestamp (replay cutoff).
   */
  async reconcileBalance(
    employeeId: string,
    locationId: string,
    hcmValue: number,
    asOf: Date,
  ): Promise<void> {
    throw new Error('NotImplemented: ReconciliationService.reconcileBalance');
  }
}
