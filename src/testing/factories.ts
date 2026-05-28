/**
 * Seed factories — minimal helpers for creating test fixtures.
 *
 * Each function accepts a TypeORM Repository plus partial overrides;
 * defaults are chosen so callers only supply the one or two fields they care
 * about for a given test.
 *
 * Usage example:
 *
 *   const balanceRepo = moduleRef.get<Repository<Balance>>(getRepositoryToken(Balance));
 *   await seedBalance(balanceRepo, { available: 5 });
 *
 *   const requestRepo = moduleRef.get<Repository<TimeOffRequest>>(
 *     getRepositoryToken(TimeOffRequest)
 *   );
 *   await seedRequest(requestRepo, { status: RequestStatus.APPROVED, days: 2 });
 */

import { Repository } from 'typeorm';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { BatchSyncLog } from '../entities/batch-sync-log.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import {
  RequestStatus,
  OutboxOperation,
  OutboxStatus,
  ReconResolution,
} from '../entities/enums';
import * as crypto from 'crypto';

/** Generate a random UUID v4 using Node.js built-in crypto. */
function uuidv4(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export interface SeedBalanceOptions {
  employeeId?: string;
  locationId?: string;
  available?: number;
  reserved?: number;
  needsReview?: boolean;
  /**
   * Defaults to 2026-05-27T00:00:00Z (a warm row — ADR-014 hot path).
   * Pass `null` explicitly when you need to test cold-cache hydration.
   */
  lastHcmAsOf?: Date | null;
}

/**
 * Insert (or upsert by composite PK) a Balance row.
 * Returns the saved entity.
 */
export async function seedBalance(
  repo: Repository<Balance>,
  opts: SeedBalanceOptions = {},
): Promise<Balance> {
  const entity = repo.create({
    employeeId: opts.employeeId ?? 'emp1',
    locationId: opts.locationId ?? 'loc1',
    available: opts.available ?? 10,
    reserved: opts.reserved ?? 0,
    needsReview: opts.needsReview ?? false,
    // Default to a warm row so integration tests (which seed DB state and test
    // lifecycle, not cold-read hydration) hit the ADR-014 hot path and don't
    // accidentally trigger an HCM call. Pass null explicitly to test cold-read.
    lastHcmAsOf:
      opts.lastHcmAsOf !== undefined
        ? opts.lastHcmAsOf
        : new Date('2026-05-27T00:00:00Z'),
  });
  return repo.save(entity);
}

// ---------------------------------------------------------------------------
// TimeOffRequest
// ---------------------------------------------------------------------------

export interface SeedRequestOptions {
  id?: string;
  employeeId?: string;
  locationId?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  status?: RequestStatus;
  idempotencyKey?: string;
  hcmIdempotencyKey?: string;
  /** Defaults to 2026-06-15 if not supplied. */
  expiresAt?: Date;
  committedAt?: Date | null;
  hcmAckAt?: Date | null;
}

/**
 * Insert a TimeOffRequest row with sensible defaults.
 * Returns the saved entity.
 */
export async function seedRequest(
  repo: Repository<TimeOffRequest>,
  opts: SeedRequestOptions = {},
): Promise<TimeOffRequest> {
  const entity = repo.create({
    id: opts.id ?? uuidv4(),
    employeeId: opts.employeeId ?? 'emp1',
    locationId: opts.locationId ?? 'loc1',
    startDate: opts.startDate ?? '2026-06-01',
    endDate: opts.endDate ?? '2026-06-02',
    days: opts.days ?? 2,
    status: opts.status ?? RequestStatus.PENDING,
    idempotencyKey: opts.idempotencyKey ?? uuidv4(),
    hcmIdempotencyKey: opts.hcmIdempotencyKey ?? uuidv4(),
    expiresAt: opts.expiresAt ?? new Date('2026-06-15T00:00:00Z'),
    committedAt: opts.committedAt !== undefined ? opts.committedAt : null,
    hcmAckAt: opts.hcmAckAt !== undefined ? opts.hcmAckAt : null,
  });
  return repo.save(entity);
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface SeedOutboxOptions {
  aggregateId: string;
  operation?: OutboxOperation;
  status?: OutboxStatus;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  attempts?: number;
}

/**
 * Insert an Outbox row.
 * `aggregateId` (requestId) is required — the caller always knows which request.
 * Returns the saved entity.
 */
export async function seedOutbox(
  repo: Repository<Outbox>,
  opts: SeedOutboxOptions,
): Promise<Outbox> {
  const key = opts.idempotencyKey ?? uuidv4();
  const entity = repo.create({
    aggregateId: opts.aggregateId,
    operation: opts.operation ?? OutboxOperation.FILE,
    status: opts.status ?? OutboxStatus.PENDING,
    idempotencyKey: key,
    payload: opts.payload ?? {
      employeeId: 'emp1',
      locationId: 'loc1',
      days: 2,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      idempotencyKey: key,
    },
    attempts: opts.attempts ?? 0,
  });
  return repo.save(entity);
}

// ---------------------------------------------------------------------------
// BatchSyncLog
// ---------------------------------------------------------------------------

export interface SeedBatchSyncLogOptions {
  sequence: number;
  asOf?: Date;
}

/**
 * Insert a BatchSyncLog row.
 * `sequence` is the monotonic PK — caller must pick a unique value.
 * Returns the saved entity.
 */
export async function seedBatchSyncLog(
  repo: Repository<BatchSyncLog>,
  opts: SeedBatchSyncLogOptions,
): Promise<BatchSyncLog> {
  const entity = repo.create({
    sequence: opts.sequence,
    asOf: opts.asOf ?? new Date('2026-05-27T00:00:00Z'),
  });
  return repo.save(entity);
}

// ---------------------------------------------------------------------------
// ReconciliationEvent
// ---------------------------------------------------------------------------

export interface SeedReconciliationEventOptions {
  employeeId?: string;
  locationId?: string;
  localValue?: number;
  hcmValue?: number;
  resolution?: ReconResolution;
}

/**
 * Insert a ReconciliationEvent audit row.
 * Returns the saved entity.
 */
export async function seedReconciliationEvent(
  repo: Repository<ReconciliationEvent>,
  opts: SeedReconciliationEventOptions = {},
): Promise<ReconciliationEvent> {
  const entity = repo.create({
    employeeId: opts.employeeId ?? 'emp1',
    locationId: opts.locationId ?? 'loc1',
    localValue: opts.localValue ?? 10,
    hcmValue: opts.hcmValue ?? 10,
    resolution: opts.resolution ?? ReconResolution.NO_CHANGE,
  });
  return repo.save(entity);
}
