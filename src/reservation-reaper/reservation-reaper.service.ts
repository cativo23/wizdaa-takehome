import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { RequestStatus } from '../entities/enums';
import {
  BalanceLockService,
  balanceKey,
} from '../common/lock/balance-lock.service';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';

/**
 * ReservationReaper — sweeps expired PENDING/PENDING_SYNC requests and
 * releases their reservations (ADR-002).
 *
 * Runs on a scheduled interval (every 5 minutes by default).
 *
 * Critical invariant (ADR-002/B2):
 *   For each expired request, the reaper must, IN THE SAME TRANSACTION:
 *     1. Release the reservation (reserved -= days).
 *     2. VOID any PENDING outbox FILE row for that request.
 *     3. Transition status to EXPIRED.
 *   This prevents the OutboxDispatcher from filing to HCM after the
 *   reservation was released.
 *
 * Each expiry runs under the per-balance-key lock (ADR-010) so it serializes
 * with all other balance actors.
 */
@Injectable()
export class ReservationReaperService {
  private readonly logger = new Logger(ReservationReaperService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Outbox)
    private readonly outboxRepo: Repository<Outbox>,
    private readonly lockService: BalanceLockService,
    private readonly timeOffRequestService: TimeOffRequestService,
    @Inject(CLOCK)
    private readonly clock: Clock,
  ) {}

  /**
   * Sweep all PENDING/PENDING_SYNC requests whose expiresAt <= now.
   * For each expired request, acquires the balance-key lock and calls expire().
   *
   * ADR-002: runs on a 5-minute schedule; reaper TTL defaults to 14 days.
   * E15/E24.
   *
   * Public so tests can trigger manually via FakeClock without waiting for
   * the scheduler.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const now = this.clock.now();

    const expired = await this.requestRepo.find({
      where: {
        expiresAt: LessThanOrEqual(now),
        status: In([RequestStatus.PENDING, RequestStatus.PENDING_SYNC]),
      },
    });

    for (const req of expired) {
      await this.lockService.runExclusive(
        balanceKey(req.employeeId, req.locationId),
        async () => {
          try {
            await this.timeOffRequestService.expire(req.id);
          } catch (e) {
            // Status may have changed between find() and expire() — e.g. cancelled
            // or approved by a concurrent actor. Log the request ID only (no PHI)
            // and continue so one failure does not abort the whole sweep.
            this.logger.warn(
              `sweep: expire skipped for request ${req.id} — ${(e as Error).message}`,
            );
          }
        },
      );
    }
  }
}
