import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { HcmBalance } from '../hcm/contracts/hcm.types';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { CLOCK } from '../common/clock/clock.tokens';
import type { Clock } from '../common/clock/clock.interface';

/**
 * BalanceService — all balance-level reads and mutations.
 *
 * Every method that mutates a balance MUST be called under the balance-key
 * lock (ADR-010). The lock is acquired by the calling service (e.g.,
 * TimeOffRequestService at submit/approve, ReconciliationService at ingest)
 * so BalanceService methods can be composed inside a single lock acquisition.
 *
 * The only exception is `getBalance` (read-only) — it doesn't need the lock.
 */
@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly lockService: BalanceLockService,
    @Inject(CLOCK)
    private readonly clock: Clock,
  ) {}

  /**
   * Read-only: return the current balance for (employeeId, locationId).
   * Creates a zero balance record if none exists yet (first-access bootstrap).
   * FR-1.
   */
  async getBalance(employeeId: string, locationId: string): Promise<Balance> {
    throw new Error('NotImplemented: BalanceService.getBalance');
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
    throw new Error('NotImplemented: BalanceService.validateAvailability');
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
  ): Promise<void> {
    throw new Error('NotImplemented: BalanceService.reserve');
  }

  /**
   * Release a reservation: reserved -= days.
   * Called on REJECTED, EXPIRED, and cancel of a PENDING/PENDING_SYNC request.
   * Does NOT touch `available` — the days were never committed.
   * Called inside the balance-key lock.
   */
  async release(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<void> {
    throw new Error('NotImplemented: BalanceService.release');
  }

  /**
   * Commit an approved request: available -= days, reserved -= days.
   * Sets Balance.lastHcmAsOf when called with an HCM ack timestamp.
   * Called inside the balance-key lock by the approve path (ADR-001 step 4).
   */
  async commit(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<void> {
    throw new Error('NotImplemented: BalanceService.commit');
  }

  /**
   * Restore balance on cancel of an APPROVED request: available += days.
   * Called inside the balance-key lock by TimeOffRequestService.cancel.
   */
  async restore(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<void> {
    throw new Error('NotImplemented: BalanceService.restore');
  }

  /**
   * Apply a fresh HCM realtime balance snapshot (ADR-001 step 2).
   * Sets Balance.available = snapshot.balance, Balance.lastHcmAsOf = snapshot.asOf.
   * Called inside the balance-key lock during the approve sequence.
   */
  async applyHcmSnapshot(snapshot: HcmBalance): Promise<void> {
    throw new Error('NotImplemented: BalanceService.applyHcmSnapshot');
  }

  /**
   * Reconcile a balance against an HCM batch entry (ADR-003).
   * Sets base = hcmValue, then replays local effects with hcmAckAt IS NULL OR > asOf,
   * plus outstanding reservations, plus pending REVERSEs.
   * Creates a ReconciliationEvent. Sets needsReview if result is negative.
   * Called inside the balance-key lock by ReconciliationService.
   *
   * @param hcmEntry  - The HcmBalance from the batch corpus.
   * @param asOf      - The batch asOf timestamp (ADR-003 replay cutoff).
   */
  async reconcileBalance(hcmEntry: HcmBalance, asOf: Date): Promise<void> {
    throw new Error('NotImplemented: BalanceService.reconcileBalance');
  }

  /**
   * Clear the needsReview flag after manager resolution (ADR-003/B4).
   * Manager-only. Called inside the balance-key lock by the manager route.
   */
  async resolveReview(employeeId: string, locationId: string): Promise<void> {
    throw new Error('NotImplemented: BalanceService.resolveReview');
  }
}
