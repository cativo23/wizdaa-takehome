import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { Outbox } from '../entities/outbox.entity';
import type { HcmClient } from './contracts/hcm-client.interface';
import { HCM_CLIENT } from './hcm.tokens';
import { BalanceLockService } from '../common/lock/balance-lock.service';

/**
 * OutboxDispatcherService — polls PENDING outbox rows and dispatches them to
 * HCM (ADR-011, ADR-004).
 *
 * Design contract:
 * - Runs on a fixed interval (configurable; defaults to every 5 s).
 * - For each PENDING row: acquire the balance-key lock (ADR-010), call the
 *   appropriate HcmClient method, mark SENT (and set hcmAckAt) or FAILED.
 * - On FAILED reaching hcmRetryMaxAttempts: enqueue a REVERSE row and
 *   transition the request to REJECTED (ADR-004).
 * - VOIDED rows (voided by the Reaper or a cancel) are skipped.
 * - All state transitions happen under the balance-key lock so they cannot
 *   interleave with the Reaper, Reconciliation, or Approve paths (ADR-010).
 */
@Injectable()
export class OutboxDispatcherService {
  constructor(
    @InjectRepository(Outbox)
    private readonly outboxRepo: Repository<Outbox>,
    @Inject(HCM_CLIENT)
    private readonly hcmClient: HcmClient,
    private readonly lockService: BalanceLockService,
  ) {}

  /**
   * Main dispatch loop — called on a 5-second interval.
   * Processes all PENDING outbox rows that are ready to send.
   *
   * Each row is processed under the per-balance-key lock so it serializes
   * with other actors mutating the same balance (ADR-010).
   */
  @Interval(5_000)
  async dispatchPending(): Promise<void> {
    throw new Error('NotImplemented: OutboxDispatcherService.dispatchPending');
  }

  /**
   * Dispatch a single outbox row.
   * Called by dispatchPending; may also be called directly in tests to
   * drive a specific row without waiting for the interval.
   *
   * Callers must NOT hold the balance-key lock — this method acquires it.
   */
  async dispatchOne(outboxId: string): Promise<void> {
    throw new Error('NotImplemented: OutboxDispatcherService.dispatchOne');
  }
}
