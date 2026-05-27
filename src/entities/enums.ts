/**
 * All domain enums — string-backed so SQLite stores them as readable text.
 * These are the canonical values; never use raw strings in domain code.
 */

export enum RequestStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  PENDING_SYNC = 'PENDING_SYNC',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/** Terminal states — a request in one of these can be replaced by a fresh submit */
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set([
  RequestStatus.REJECTED,
  RequestStatus.CANCELLED,
  RequestStatus.EXPIRED,
]);

/** Active (non-terminal) states — idempotency key uniqueness is scoped to these (ADR-012) */
export const ACTIVE_STATUSES: ReadonlySet<RequestStatus> = new Set([
  RequestStatus.DRAFT,
  RequestStatus.PENDING,
  RequestStatus.PENDING_SYNC,
  RequestStatus.APPROVED,
]);

export enum OutboxOperation {
  FILE = 'FILE',
  REVERSE = 'REVERSE',
}

export enum OutboxStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  VOIDED = 'VOIDED',
}

export enum ReconResolution {
  REPLAYED = 'REPLAYED',
  FLAGGED_NEGATIVE = 'FLAGGED_NEGATIVE',
  NO_CHANGE = 'NO_CHANGE',
  STALE_REJECTED = 'STALE_REJECTED',
}
