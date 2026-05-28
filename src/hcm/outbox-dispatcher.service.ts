import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { Outbox } from '../entities/outbox.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { OutboxOperation, OutboxStatus, RequestStatus } from '../entities/enums';
import type { HcmClient } from './contracts/hcm-client.interface';
import type {
  FileTimeOffCommand,
  ReverseTimeOffCommand,
} from './contracts/hcm.types';
import { HCM_CLIENT } from './hcm.tokens';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { BalanceService } from '../balance/balance.service';
import { AppConfigService } from '../config/app-config.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';

/**
 * OutboxDispatcherService — polls PENDING outbox rows and dispatches them to
 * HCM (ADR-011, ADR-004).
 *
 * Design contract:
 * - Runs on a fixed interval (5 s by default; @Interval decorator).
 * - For each PENDING row: acquire the balance-key lock (ADR-010), call the
 *   appropriate HcmClient method, mark SENT (and set hcmAckAt) or FAILED.
 * - On FAILED reaching hcmRetryMaxAttempts: enqueue a REVERSE row and
 *   transition the request to REJECTED (ADR-004 / E5 / E25).
 * - VOIDED rows (voided by the Reaper or a cancel) are skipped.
 * - All state transitions happen under the balance-key lock so they cannot
 *   interleave with the Reaper, Reconciliation, or Approve paths (ADR-010).
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  constructor(
    @InjectRepository(Outbox)
    private readonly outboxRepo: Repository<Outbox>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @Inject(HCM_CLIENT)
    private readonly hcmClient: HcmClient,
    private readonly lockService: BalanceLockService,
    private readonly balanceService: BalanceService,
    private readonly appConfig: AppConfigService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Main dispatch loop — called on a 5-second interval.
   * Processes all PENDING outbox rows oldest-first.
   *
   * Exposed as public so tests can invoke it directly without waiting for
   * the scheduled tick.
   */
  @Interval(5_000)
  async dispatchPending(): Promise<void> {
    const pendingRows = await this.outboxRepo.find({
      where: { status: OutboxStatus.PENDING },
      order: { createdAt: 'ASC' },
    });

    for (const row of pendingRows) {
      await this.dispatchOne(row.id);
    }
  }

  /**
   * Dispatch a single outbox row.
   * Called by dispatchPending; may also be called directly in tests to
   * drive a specific row without waiting for the interval.
   *
   * Callers must NOT hold the balance-key lock — this method acquires it.
   */
  async dispatchOne(outboxId: string): Promise<void> {
    // --- Fast pre-check: load the row and bail early if not PENDING ---
    const outboxPreCheck = await this.outboxRepo.findOne({ where: { id: outboxId } });
    if (!outboxPreCheck) {
      this.logger.warn(`dispatchOne: outbox row ${outboxId} not found — skipping`);
      return;
    }
    if (outboxPreCheck.status !== OutboxStatus.PENDING) {
      return; // Already handled (SENT, FAILED, VOIDED)
    }

    // Load the corresponding request to resolve the balance key for the lock.
    const requestPreCheck = await this.requestRepo.findOne({
      where: { id: outboxPreCheck.aggregateId },
    });
    if (!requestPreCheck) {
      this.logger.warn(
        `dispatchOne: request ${outboxPreCheck.aggregateId} not found for outbox ${outboxId} — skipping`,
      );
      return;
    }

    const key = balanceKey(requestPreCheck.employeeId, requestPreCheck.locationId);

    await this.lockService.runExclusive(key, async () => {
      // --- Transaction 1: re-read under lock, increment attempts ---
      let outbox: Outbox;
      let request: TimeOffRequest;
      let shouldProceed = true;

      await this.dataSource.transaction(async (manager: EntityManager) => {
        const txOutbox = await manager.getRepository(Outbox).findOne({ where: { id: outboxId } });
        if (!txOutbox || txOutbox.status !== OutboxStatus.PENDING) {
          // Another actor already handled this row (racy VOID, concurrent dispatcher tick, etc.)
          shouldProceed = false;
          return;
        }

        const txRequest = await manager.getRepository(TimeOffRequest).findOne({
          where: { id: txOutbox.aggregateId },
        });
        if (!txRequest) {
          this.logger.warn(
            `dispatchOne[txn1]: request ${txOutbox.aggregateId} not found — marking outbox FAILED`,
          );
          txOutbox.status = OutboxStatus.FAILED;
          await manager.save(Outbox, txOutbox);
          shouldProceed = false;
          return;
        }

        // Increment attempts BEFORE the HCM call so that a crash mid-dispatch is counted.
        txOutbox.attempts += 1;
        await manager.save(Outbox, txOutbox);

        // Capture entities for use outside the transaction
        outbox = txOutbox;
        request = txRequest;
      });

      if (!shouldProceed) {
        return;
      }

      // Re-assign from captured values (TypeScript flow narrowing)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      outbox = outbox!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      request = request!;

      // --- HCM call — OUTSIDE any transaction (no network I/O in a txn) ---
      const maxAttempts = this.appConfig.hcmRetryMaxAttempts;
      let hcmOk = false;
      let hcmAckedAt: Date | null = null;
      let hcmErrorHint: string | undefined;

      try {
        if (outbox.operation === OutboxOperation.FILE) {
          const cmd = outbox.payload as unknown as FileTimeOffCommand;
          const result = await this.hcmClient.fileTimeOff(cmd);
          hcmOk = result.ok;
          hcmErrorHint = result.errorHint;
          if (result.ok && result.ackedAt) {
            const parsed = new Date(result.ackedAt);
            hcmAckedAt = isNaN(parsed.getTime()) ? this.clock.now() : parsed;
          } else if (result.ok) {
            hcmAckedAt = this.clock.now();
          }
        } else {
          // OutboxOperation.REVERSE
          const cmd = outbox.payload as unknown as ReverseTimeOffCommand;
          const result = await this.hcmClient.reverseTimeOff(cmd);
          hcmOk = result.ok;
          hcmErrorHint = result.errorHint;
          if (result.ok && result.ackedAt) {
            const parsed = new Date(result.ackedAt);
            hcmAckedAt = isNaN(parsed.getTime()) ? this.clock.now() : parsed;
          } else if (result.ok) {
            hcmAckedAt = this.clock.now();
          }
        }
      } catch (err) {
        // Unexpected programming error — treat as transient failure (ok=false)
        hcmOk = false;
        hcmErrorHint = 'exception';
        this.logger.error(
          `dispatchOne: unexpected exception during HCM call for outbox ${outboxId} (operation=${outbox.operation}, attempts=${outbox.attempts})`,
          err instanceof Error ? err.stack : String(err),
        );
      }

      // --- Transaction 2: reflect the HCM result locally ---
      await this.dataSource.transaction(async (manager: EntityManager) => {
        if (hcmOk) {
          // ---------------------------------------------------------------
          // SUCCESS PATH
          // ---------------------------------------------------------------
          outbox.status = OutboxStatus.SENT;
          request.hcmAckAt = hcmAckedAt;

          if (outbox.operation === OutboxOperation.FILE) {
            // PENDING_SYNC → APPROVED (E4 happy path)
            request.status = RequestStatus.APPROVED;
          }
          // For REVERSE: status was already CANCELLED or REJECTED by the caller — leave it.

          await manager.save(Outbox, outbox);
          await manager.save(TimeOffRequest, request);

          this.logger.log(
            `dispatchOne: outbox ${outboxId} (${outbox.operation}) SENT after ${outbox.attempts} attempt(s)`,
          );
        } else {
          // ---------------------------------------------------------------
          // FAILURE PATH
          // ---------------------------------------------------------------
          if (outbox.attempts < maxAttempts) {
            // Transient failure — keep PENDING; next tick retries (E11)
            // outbox.status is still PENDING from txn1 — no change needed.
            // Re-save to persist the incremented attempts (already done in txn1,
            // but we persist the in-memory entity reference to be safe).
            await manager.save(Outbox, outbox);

            this.logger.warn(
              `dispatchOne: outbox ${outboxId} (${outbox.operation}) attempt ${outbox.attempts}/${maxAttempts} failed (hint=${hcmErrorHint ?? 'none'}) — will retry`,
            );
          } else if (outbox.operation === OutboxOperation.FILE) {
            // ---------------------------------------------------------------
            // RETRY-CAP on a FILE → compensation path (E5, E25, ADR-004)
            // ---------------------------------------------------------------
            // 1. Mark this FILE outbox row as FAILED.
            outbox.status = OutboxStatus.FAILED;

            // 2. Restore the balance — undo the local commit (available += days).
            //    Called with the transaction manager so it participates atomically.
            await this.balanceService.restore(
              request.employeeId,
              request.locationId,
              request.days,
              manager,
            );

            // 3. Transition request to REJECTED.
            request.status = RequestStatus.REJECTED;

            // 4. Enqueue a REVERSE so that any FILE that actually landed at HCM
            //    is undone (E25). The idempotency key is `${hcmIdempotencyKey}:REVERSE`
            //    so HCM deduplicates even if the dispatcher restarts mid-flight (ADR-008).
            const reversePayload: ReverseTimeOffCommand = {
              employeeId: request.employeeId,
              locationId: request.locationId,
              days: request.days,
              startDate: request.startDate,
              endDate: request.endDate,
              idempotencyKey: `${request.hcmIdempotencyKey}:REVERSE`,
            };

            const reverseOutbox = manager.getRepository(Outbox).create({
              aggregateId: request.id,
              operation: OutboxOperation.REVERSE,
              payload: reversePayload as unknown as Record<string, unknown>,
              idempotencyKey: `${request.hcmIdempotencyKey}:REVERSE`,
              status: OutboxStatus.PENDING,
              attempts: 0,
            });

            await manager.save(Outbox, outbox);
            await manager.save(TimeOffRequest, request);
            await manager.save(Outbox, reverseOutbox);

            this.logger.warn(
              `dispatchOne: outbox ${outboxId} (FILE) hit retry cap (${outbox.attempts}/${maxAttempts}) — REJECTED, REVERSE enqueued (idempotencyKey=${reversePayload.idempotencyKey})`,
            );
          } else {
            // ---------------------------------------------------------------
            // RETRY-CAP on a REVERSE — unusual edge case.
            // Log + mark FAILED; leave request status as-is (already CANCELLED or REJECTED).
            // ---------------------------------------------------------------
            outbox.status = OutboxStatus.FAILED;
            await manager.save(Outbox, outbox);

            this.logger.error(
              `dispatchOne: outbox ${outboxId} (REVERSE) hit retry cap (${outbox.attempts}/${maxAttempts}) — marking FAILED, request status unchanged (hint=${hcmErrorHint ?? 'none'})`,
            );
          }
        }
      });
    });
  }
}
