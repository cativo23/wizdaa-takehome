import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { BalanceService } from '../balance/balance.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';
import type { HcmClient } from '../hcm/contracts/hcm-client.interface';
import { HCM_CLIENT } from '../hcm/hcm.tokens';
import { AppConfigService } from '../config/app-config.service';

/**
 * TimeOffRequestService — the lifecycle state machine (§6).
 *
 * State transitions (§6):
 *   submit:  (DRAFT →) PENDING
 *   approve: PENDING → APPROVED | PENDING_SYNC (HCM down) | REJECTED (insufficient)
 *   reject:  PENDING | PENDING_SYNC → REJECTED
 *   cancel:  PENDING | PENDING_SYNC | APPROVED → CANCELLED
 *   expire:  PENDING | PENDING_SYNC → EXPIRED (called by ReservationReaper)
 *
 * All methods that mutate a balance acquire the per-balance-key lock (ADR-010)
 * before touching the balance or the request. The submit path also enforces
 * ADR-012 (idempotency key + overlap invariant) under the lock.
 */
@Injectable()
export class TimeOffRequestService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Outbox)
    private readonly outboxRepo: Repository<Outbox>,
    private readonly balanceService: BalanceService,
    private readonly lockService: BalanceLockService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    @Inject(HCM_CLIENT)
    private readonly hcmClient: HcmClient,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Submit a time-off request. FR-2/FR-3. ADR-002/ADR-012.
   *
   * Sequence (all under balance-key lock):
   *   1. Validate idempotency key (ADR-012 ①): if active request with same key exists,
   *      return it. If key matches a different body → 422.
   *   2. Check overlap invariant (ADR-012 ②): reject if range overlaps a non-terminal
   *      request for the same (employeeId, locationId).
   *   3. Validate availability (ADR-001 local guard). If insufficient → reject immediately.
   *   4. Create request in PENDING status, allocate hcmIdempotencyKey (UUID v4).
   *   5. Reserve balance: available -= days, reserved += days (ADR-002).
   *
   * `days` is always server-computed — never trusted from the client (§12).
   *
   * @param employeeId   - Injected by gateway (trusted, §12/A4).
   * @param locationId
   * @param startDate    - Inclusive, YYYY-MM-DD.
   * @param endDate      - Inclusive, YYYY-MM-DD.
   * @param idempotencyKey - Client-minted UUID v4 (ADR-012).
   */
  async submit(
    employeeId: string,
    locationId: string,
    startDate: string,
    endDate: string,
    idempotencyKey: string,
  ): Promise<TimeOffRequest> {
    throw new Error('NotImplemented: TimeOffRequestService.submit');
  }

  /**
   * Approve a PENDING request. FR-4/FR-5. ADR-001/ADR-004/ADR-011.
   *
   * Sequence (all under balance-key lock):
   *   1. Fetch request; assert PENDING.
   *   2. GET /hcm/balance (ADR-001 step 1 — realtime refresh).
   *   3. Apply HCM snapshot to local cache + set lastHcmAsOf (ADR-001 step 2).
   *   4. Re-validate availability against updated cache (ADR-001 step 3).
   *      If insufficient → release reservation → REJECTED.
   *   5. Validate startDate is not in the past (location-tz civil date, §10/E18).
   *   6. Commit balance: available -= days, reserved -= days; committedAt = now.
   *   7. Enqueue FILE outbox row in same transaction (ADR-011).
   *   8. Move status to APPROVED or PENDING_SYNC (if HCM is unreachable).
   *
   * @param requestId  - UUID of the TimeOffRequest.
   * @param managerId  - Authenticated manager ID (for audit; not stored on request in v1).
   */
  async approve(requestId: string, managerId: string): Promise<TimeOffRequest> {
    throw new Error('NotImplemented: TimeOffRequestService.approve');
  }

  /**
   * Reject a PENDING or PENDING_SYNC request. FR-4. ADR-002.
   *
   * Sequence (under balance-key lock):
   *   1. Fetch request; assert PENDING or PENDING_SYNC.
   *   2. Release reservation: reserved -= days.
   *   3. If PENDING_SYNC and a FILE outbox row exists → VOID it.
   *   4. Transition to REJECTED.
   *
   * @param requestId
   * @param managerId  - Authenticated manager ID.
   * @param reason     - Optional rejection reason (not logged at info level, §12).
   */
  async reject(
    requestId: string,
    managerId: string,
    reason?: string,
  ): Promise<TimeOffRequest> {
    throw new Error('NotImplemented: TimeOffRequestService.reject');
  }

  /**
   * Cancel a PENDING, PENDING_SYNC, or APPROVED request. FR-6. ADR-004/ADR-008/ADR-011.
   *
   * Sequence (under balance-key lock):
   *   PENDING:
   *     - Release reservation; VOID pending FILE outbox row → CANCELLED.
   *   PENDING_SYNC with FILE PENDING:
   *     - VOID the FILE row; release reservation → CANCELLED.
   *   PENDING_SYNC with FILE SENT:
   *     - Restore available (the FILE already landed at HCM); enqueue REVERSE → CANCELLED.
   *   APPROVED:
   *     - Restore available (available += days); enqueue REVERSE outbox row → CANCELLED.
   *
   * @param requestId
   * @param principalId - Authenticated user. Employee may only cancel their own request (§12).
   */
  async cancel(requestId: string, principalId: string): Promise<TimeOffRequest> {
    throw new Error('NotImplemented: TimeOffRequestService.cancel');
  }

  /**
   * Expire a PENDING or PENDING_SYNC request past its TTL. ADR-002/B2.
   * Called exclusively by ReservationReaper.sweep — callers should not call this directly.
   *
   * Sequence (under balance-key lock — caller holds the lock):
   *   1. Release reservation: reserved -= days.
   *   2. VOID any PENDING FILE outbox row in the SAME transaction (ADR-002/B2).
   *   3. Transition to EXPIRED.
   *
   * NOTE: the ReservationReaper acquires the lock before calling this method,
   * so this method does NOT re-acquire the lock.
   */
  async expire(requestId: string): Promise<TimeOffRequest> {
    throw new Error('NotImplemented: TimeOffRequestService.expire');
  }
}
