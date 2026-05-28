import {
  Injectable,
  Inject,
  ConflictException,
  UnprocessableEntityException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import {
  RequestStatus,
  OutboxOperation,
  OutboxStatus,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
} from '../entities/enums';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { BalanceService } from '../balance/balance.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';
import type { HcmClient } from '../hcm/contracts/hcm-client.interface';
import type { FileTimeOffCommand, ReverseTimeOffCommand } from '../hcm/contracts/hcm.types';
import { HCM_CLIENT } from '../hcm/hcm.tokens';
import { HcmUnavailableError } from '../hcm/hcm.errors';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Business-day calculator (A6 dependency seam)
  // ---------------------------------------------------------------------------

  /**
   * Count business days (Mon–Fri) in the inclusive range [startDate, endDate].
   * Dates are YYYY-MM-DD civil-date strings and are treated as the
   * location-timezone civil date (§10) — no UTC conversion is applied.
   *
   * Holidays are out of scope for v1. A real location calendar (A6) would
   * populate `holidays` with YYYY-MM-DD strings for that location.
   *
   * @throws UnprocessableEntityException if endDate < startDate.
   */
  private countBusinessDays(
    startDate: string,
    endDate: string,
    // TODO(A6): replace with a real location calendar lookup once the
    // calendar service is available.
    holidays: Set<string> = new Set(),
  ): number {
    if (endDate < startDate) {
      throw new UnprocessableEntityException(
        'endDate must not be before startDate',
      );
    }

    let count = 0;
    // Parse as civil dates (no timezone conversion; treat YYYY-MM-DD literally).
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);

    // Use UTC-based Date to avoid local-TZ day-boundary skew while still
    // iterating civil calendar days.
    const cursor = new Date(Date.UTC(sy, sm - 1, sd));
    const end = new Date(Date.UTC(ey, em - 1, ed));

    while (cursor <= end) {
      const dow = cursor.getUTCDay(); // 0=Sun, 6=Sat
      const isoDate = cursor.toISOString().slice(0, 10);
      if (dow !== 0 && dow !== 6 && !holidays.has(isoDate)) {
        count++;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return count;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a FILE outbox payload.
   */
  private buildFileCommand(req: TimeOffRequest): FileTimeOffCommand {
    return {
      employeeId: req.employeeId,
      locationId: req.locationId,
      days: req.days,
      startDate: req.startDate,
      endDate: req.endDate,
      idempotencyKey: `${req.hcmIdempotencyKey}:FILE`,
    };
  }

  /**
   * Build a REVERSE outbox payload.
   */
  private buildReverseCommand(req: TimeOffRequest): ReverseTimeOffCommand {
    return {
      employeeId: req.employeeId,
      locationId: req.locationId,
      days: req.days,
      startDate: req.startDate,
      endDate: req.endDate,
      idempotencyKey: `${req.hcmIdempotencyKey}:REVERSE`,
    };
  }

  /**
   * Write an Outbox row using the given entity manager (for transactional use).
   */
  private buildOutboxRow(
    req: TimeOffRequest,
    operation: OutboxOperation,
    manager: EntityManager,
  ): Outbox {
    const payload =
      operation === OutboxOperation.FILE
        ? (this.buildFileCommand(req) as unknown as Record<string, unknown>)
        : (this.buildReverseCommand(req) as unknown as Record<string, unknown>);

    return manager.create(Outbox, {
      aggregateId: req.id,
      operation,
      payload,
      idempotencyKey: `${req.hcmIdempotencyKey}:${operation}`,
      status: OutboxStatus.PENDING,
      attempts: 0,
    });
  }

  /**
   * Void any PENDING FILE outbox rows for the given requestId using the
   * given entity manager. Used by expire, reject (PENDING_SYNC), and cancel.
   */
  private async voidPendingFileRows(
    requestId: string,
    manager: EntityManager,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Outbox)
      .set({ status: OutboxStatus.VOIDED })
      .where('aggregateId = :requestId', { requestId })
      .andWhere('operation = :op', { op: OutboxOperation.FILE })
      .andWhere('status = :status', { status: OutboxStatus.PENDING })
      .execute();
  }

  // ---------------------------------------------------------------------------
  // Public state-machine methods
  // ---------------------------------------------------------------------------

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
    // Pre-warm: if the balance row is cold (lastHcmAsOf === null), getBalance triggers the
    // ADR-014 lazy-hydrate which calls lockService.runExclusive on the same key internally.
    // Calling it BEFORE we acquire our own lock prevents re-entrant deadlock (ADR-010 + ADR-014).
    await this.balanceService.getBalance(employeeId, locationId);

    const key = balanceKey(employeeId, locationId);
    return this.lockService.runExclusive(key, async () => {
      // ① Idempotency check (ADR-012 §1)
      const existing = await this.requestRepo.findOne({
        where: { idempotencyKey },
      });

      if (existing) {
        if (ACTIVE_STATUSES.has(existing.status)) {
          // Same key + same body → idempotent replay
          if (
            existing.employeeId === employeeId &&
            existing.locationId === locationId &&
            existing.startDate === startDate &&
            existing.endDate === endDate
          ) {
            return existing; // E8: idempotent replay
          }
          // Same key + different body → client bug (E23)
          throw new UnprocessableEntityException(
            'Idempotency key reuse: request body does not match the original submission',
          );
        }
        // Key exists but in TERMINAL state — allow fresh submit (E28, L1)
        // Fall through to create a new request below.
      }

      // ② Overlap invariant (ADR-012 §2, E19, E20)
      const overlapping = await this.requestRepo
        .createQueryBuilder('r')
        .where('r.employeeId = :employeeId', { employeeId })
        .andWhere('r.locationId = :locationId', { locationId })
        .andWhere('r.status NOT IN (:...terminalStatuses)', {
          terminalStatuses: [...TERMINAL_STATUSES],
        })
        .andWhere('r.startDate <= :endDate', { endDate })
        .andWhere('r.endDate >= :startDate', { startDate })
        .getOne();

      if (overlapping) {
        throw new ConflictException(
          `Date range overlaps with an existing active request (${overlapping.id})`,
        );
      }

      // ③ Compute days server-side (§12, A6 seam)
      const days = this.countBusinessDays(startDate, endDate);

      // ③ Availability check (ADR-001 local guard, E1)
      await this.balanceService.validateAvailability(employeeId, locationId, days);

      // ④⑤ Create PENDING request + reserve balance atomically
      const now = this.clock.now();
      const ttlMs = this.config.reservationTtlDays * 24 * 60 * 60 * 1000;
      const expiresAt = new Date(now.getTime() + ttlMs);

      // Handle unique constraint violation when a terminal key was just reused:
      // we need a fresh record even though the old one exists (E28).
      const request = this.requestRepo.create({
        employeeId,
        locationId,
        startDate,
        endDate,
        days,
        status: RequestStatus.PENDING,
        idempotencyKey,
        hcmIdempotencyKey: randomUUID(),
        expiresAt,
        committedAt: null,
        hcmAckAt: null,
      });

      await this.dataSource.transaction(async (manager) => {
        // If the old terminal request exists with the same idempotency key,
        // clear the key on the old row first so the UNIQUE constraint won't block.
        if (existing && TERMINAL_STATUSES.has(existing.status)) {
          await manager.update(
            TimeOffRequest,
            { id: existing.id },
            { idempotencyKey: `${existing.idempotencyKey}:terminal:${existing.id}` },
          );
        }
        await manager.save(TimeOffRequest, request);
        // Pass manager so balance + request writes commit in one transaction (ADR-013/Gap B).
        await this.balanceService.reserve(employeeId, locationId, days, manager);
      });

      // Reload to get DB-generated fields (id, version, createdAt, updatedAt).
      const saved = await this.requestRepo.findOne({
        where: { id: request.id },
      });
      return saved ?? request;
    });
  }

  /**
   * Approve a PENDING request. FR-4/FR-5. ADR-001/ADR-004/ADR-011.
   *
   * Pure Outbox model (decided): approve commits locally and enqueues a FILE
   * outbox row. The OutboxDispatcher drives the terminal HCM outcome.
   *
   * Sequence (all under balance-key lock):
   *   1. Fetch request; assert PENDING.
   *   2. Past-date check: if startDate < clock.now() civil date → REJECTED + release.
   *   3. Best-effort HCM balance refresh:
   *      - ok     → applyHcmSnapshot; if available < days → REJECTED + release (E10).
   *      - HcmUnavailableError → skip refresh, proceed on local cache (ADR-001).
   *   4. Commit balance: available -= days, reserved -= days; committedAt = now.
   *   5. Write Outbox(FILE) + set status = PENDING_SYNC — all in ONE transaction.
   *
   * @param requestId  - UUID of the TimeOffRequest.
   * @param managerId  - Authenticated manager ID (for audit; not stored on request in v1).
   */
  async approve(requestId: string, managerId: string): Promise<TimeOffRequest> {
    // Load first (outside lock) to get employeeId/locationId for the key.
    const preload = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!preload) {
      throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
    }

    // Pre-warm: ensures getBalance's cold-path lock (ADR-014) fires before we hold
    // our own lock on the same key — avoids re-entrant deadlock (ADR-010 + ADR-014).
    await this.balanceService.getBalance(preload.employeeId, preload.locationId);

    const key = balanceKey(preload.employeeId, preload.locationId);
    return this.lockService.runExclusive(key, async () => {
      // Reload inside the lock for a consistent view.
      const req = await this.requestRepo.findOne({ where: { id: requestId } });
      if (!req) {
        throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
      }
      if (req.status !== RequestStatus.PENDING) {
        throw new BadRequestException(
          `Cannot approve a request in status ${req.status}`,
        );
      }

      // Past-date check (§10/E18): evaluate in location-tz civil date.
      // The civil date of now is the YYYY-MM-DD prefix of the UTC ISO string
      // (§10: "all timestamps stored UTC; convert to location-tz civil date at display layer").
      // For v1 the location calendar is stubbed — we use UTC civil date as a proxy.
      const nowCivilDate = this.clock.now().toISOString().slice(0, 10);
      if (req.startDate < nowCivilDate) {
        // startDate is in the past — reject and release reservation (E18).
        // Wrap in own transaction so release + request save are atomic (ADR-013/Gap B).
        await this.dataSource.transaction(async (manager) => {
          await this.balanceService.release(req.employeeId, req.locationId, req.days, manager);
          req.status = RequestStatus.REJECTED;
          await manager.save(TimeOffRequest, req);
        });
        return req;
      }

      // Best-effort HCM balance refresh (ADR-001 step 1–2).
      // applyHcmSnapshot is a single-write on the balance — left outside the main
      // transaction; if the subsequent commit transaction rolls back, the snapshot
      // effect is at worst a slightly-fresher local cache, which is acceptable (ADR-013).
      //
      // Pass retry:false so a down HCM degrades fast (≤2.5 s) rather than
      // burning the 31-second retry budget. ADR-001 already says approve falls
      // through to local cache on HCM unavailable; this just makes the fallthrough
      // fast rather than after 31 s of backoff.
      let hcmRefreshFailed = false;
      try {
        const snapshot = await this.hcmClient.getBalance(req.employeeId, req.locationId, { retry: false });
        await this.balanceService.applyHcmSnapshot(snapshot);

        // Re-validate after snapshot update (ADR-001 step 3, E10).
        // Use available - reserved for the free-days check (A1 fix applied consistently).
        const balance = await this.balanceService.getBalance(req.employeeId, req.locationId);
        const free = balance.available - balance.reserved;
        if (free < req.days) {
          // Insufficient after HCM refresh — reject and release (E10).
          // Wrap in own transaction for atomicity (ADR-013/Gap B).
          await this.dataSource.transaction(async (manager) => {
            await this.balanceService.release(req.employeeId, req.locationId, req.days, manager);
            req.status = RequestStatus.REJECTED;
            await manager.save(TimeOffRequest, req);
          });
          return req;
        }
      } catch (err) {
        if (err instanceof HcmUnavailableError) {
          // HCM down — skip refresh, proceed on local cache (ADR-001)
          hcmRefreshFailed = true;
        } else {
          throw err;
        }
      }

      // Step 4–5: commit balance + write Outbox(FILE) + status = PENDING_SYNC
      // All in ONE transaction (ADR-011/ADR-013).
      const now = this.clock.now();
      await this.dataSource.transaction(async (manager) => {
        // Commit: available -= days, reserved -= days. Pass manager for atomicity (ADR-013/Gap B).
        await this.balanceService.commit(req.employeeId, req.locationId, req.days, manager);

        req.committedAt = now;
        req.status = RequestStatus.PENDING_SYNC;

        const outboxRow = this.buildOutboxRow(req, OutboxOperation.FILE, manager);
        await manager.save(Outbox, outboxRow);
        await manager.save(TimeOffRequest, req);
      });

      // Silence the unused variable warning — hcmRefreshFailed is noted for context.
      void hcmRefreshFailed;

      return req;
    });
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
    const preload = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!preload) {
      throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
    }

    // Pre-warm: ensures getBalance's cold-path lock (ADR-014) fires before we hold
    // our own lock on the same key — avoids re-entrant deadlock (ADR-010 + ADR-014).
    await this.balanceService.getBalance(preload.employeeId, preload.locationId);

    const key = balanceKey(preload.employeeId, preload.locationId);
    return this.lockService.runExclusive(key, async () => {
      const req = await this.requestRepo.findOne({ where: { id: requestId } });
      if (!req) {
        throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
      }

      if (
        req.status !== RequestStatus.PENDING &&
        req.status !== RequestStatus.PENDING_SYNC
      ) {
        throw new BadRequestException(
          `Cannot reject a request in status ${req.status}`,
        );
      }

      // reason is not persisted (no column in v1) but accepted for extensibility
      void reason;

      await this.dataSource.transaction(async (manager) => {
        if (req.status === RequestStatus.PENDING) {
          // PENDING: release the reservation (reserved -= days). available is untouched
          // because reserve() only incremented reserved (A1/A2 fix model).
          await this.balanceService.release(req.employeeId, req.locationId, req.days, manager);

        } else {
          // PENDING_SYNC: commit() already ran — available was decremented and reserved
          // was cleared. We must call restore() to add the days back to available (A4 fix).
          // Also void the in-flight FILE outbox row so HCM is not contacted after reject.
          await this.balanceService.restore(req.employeeId, req.locationId, req.days, manager);
          await this.voidPendingFileRows(requestId, manager);
        }

        req.status = RequestStatus.REJECTED;
        await manager.save(TimeOffRequest, req);
      });

      return req;
    });
  }

  /** Fetch a request by ID without locking. Used by the controller for IDOR pre-checks. */
  async findById(requestId: string): Promise<TimeOffRequest | null> {
    return this.requestRepo.findOne({ where: { id: requestId } });
  }

  /**
   * Cancel a PENDING, PENDING_SYNC, or APPROVED request. FR-6. ADR-004/ADR-008/ADR-011.
   * IDOR ownership check (employees may only cancel their own) is enforced by the controller.
   *
   * Branches (all under balance-key lock):
   *   PENDING:
   *     - Void pending FILE outbox rows; release reservation → CANCELLED.
   *   PENDING_SYNC with FILE PENDING (unsent):
   *     - Void the FILE row; restore available (commit already happened) → CANCELLED.
   *     Wait — PENDING_SYNC means commit happened; reservation was moved to committed.
   *     So we restore (available += days) not release.
   *   PENDING_SYNC with FILE SENT (already landed at HCM):
   *     - Restore available + enqueue REVERSE → CANCELLED.
   *   APPROVED:
   *     - Restore available (available += days) + enqueue REVERSE → CANCELLED.
   *
   * @param requestId
   * @param _principalId - Caller identity; ownership is enforced by the controller before this is called.
   */
  async cancel(requestId: string, _principalId: string): Promise<TimeOffRequest> {
    const preload = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!preload) {
      throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
    }

    // Pre-warm: ensures getBalance's cold-path lock (ADR-014) fires before we hold
    // our own lock on the same key — avoids re-entrant deadlock (ADR-010 + ADR-014).
    await this.balanceService.getBalance(preload.employeeId, preload.locationId);

    const key = balanceKey(preload.employeeId, preload.locationId);
    return this.lockService.runExclusive(key, async () => {
      const req = await this.requestRepo.findOne({ where: { id: requestId } });
      if (!req) {
        throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
      }

      // Idempotent: already cancelled → return as-is (E16)
      if (req.status === RequestStatus.CANCELLED) {
        return req;
      }

      if (
        req.status !== RequestStatus.PENDING &&
        req.status !== RequestStatus.PENDING_SYNC &&
        req.status !== RequestStatus.APPROVED
      ) {
        throw new BadRequestException(
          `Cannot cancel a request in status ${req.status}`,
        );
      }

      await this.dataSource.transaction(async (manager) => {
        if (req.status === RequestStatus.PENDING) {
          // PENDING: void pending FILE rows + release reservation. Pass manager (ADR-013/Gap B).
          await this.voidPendingFileRows(requestId, manager);
          await this.balanceService.release(req.employeeId, req.locationId, req.days, manager);

        } else if (req.status === RequestStatus.PENDING_SYNC) {
          // PENDING_SYNC: commit already happened (available -= days, reserved -= days).
          // So we restore (available += days) regardless of FILE status.
          // Check whether the FILE outbox row has been sent yet.
          const fileRow = await manager.findOne(Outbox, {
            where: {
              aggregateId: requestId,
              operation: OutboxOperation.FILE,
            },
          });

          const fileSent = fileRow?.status === OutboxStatus.SENT;

          if (!fileSent) {
            // FILE not yet sent — void it; restore balance. Pass manager (ADR-013/Gap B).
            await this.voidPendingFileRows(requestId, manager);
            await this.balanceService.restore(req.employeeId, req.locationId, req.days, manager);
          } else {
            // FILE already sent (landed at HCM) — restore balance + enqueue REVERSE (E27).
            // Pass manager (ADR-013/Gap B).
            await this.balanceService.restore(req.employeeId, req.locationId, req.days, manager);
            const reverseRow = this.buildOutboxRow(req, OutboxOperation.REVERSE, manager);
            await manager.save(Outbox, reverseRow);
          }

        } else {
          // APPROVED: restore available + enqueue REVERSE (E9/FR-6). Pass manager (ADR-013/Gap B).
          await this.balanceService.restore(req.employeeId, req.locationId, req.days, manager);
          const reverseRow = this.buildOutboxRow(req, OutboxOperation.REVERSE, manager);
          await manager.save(Outbox, reverseRow);
        }

        req.status = RequestStatus.CANCELLED;
        await manager.save(TimeOffRequest, req);
      });

      return req;
    });
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
    const req = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!req) {
      throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
    }

    if (
      req.status !== RequestStatus.PENDING &&
      req.status !== RequestStatus.PENDING_SYNC
    ) {
      throw new BadRequestException(
        `Cannot expire a request in status ${req.status}`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      if (req.status === RequestStatus.PENDING) {
        // PENDING: release reservation (reserved -= days). available unchanged because
        // reserve() only incremented reserved (A1/A2 fix model). Pass manager (ADR-013/Gap B).
        await this.balanceService.release(req.employeeId, req.locationId, req.days, manager);
        // Void any pending FILE outbox row in the same transaction (B2/E24).
        await this.voidPendingFileRows(requestId, manager);

      } else {
        // PENDING_SYNC: commit() already ran — available was decremented and reserved
        // was cleared. We must call restore() to add the days back to available (A4 fix).
        // Also void the in-flight FILE outbox row so HCM is not contacted after expiry.
        await this.balanceService.restore(req.employeeId, req.locationId, req.days, manager);
        await this.voidPendingFileRows(requestId, manager);
      }

      req.status = RequestStatus.EXPIRED;
      await manager.save(TimeOffRequest, req);
    });

    return req;
  }
}
