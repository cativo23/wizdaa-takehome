/**
 * HCM Interface Contract types (§8, ADR-008).
 *
 * These are the shapes on the wire to/from HCM. All domain code uses these
 * types; the HcmClientService implements the HcmClient interface using them.
 *
 * ERROR PHILOSOPHY (ADR-001):
 * HCM errors are a HINT, never a guarantee. FileTimeOffResult and
 * ReverseTimeOffResult use a discriminated `ok` flag rather than throwing,
 * so callers can observe the outcome without crashing. The `errorHint` field
 * carries the HCM message for logging only — business decisions are based on
 * the local primary guard, not on `errorHint`.
 */

/** Realtime balance returned by GET /hcm/balance */
export interface HcmBalance {
  employeeId: string;
  locationId: string;
  /** Available balance at HCM as of `asOf`. */
  balance: number;
  /** HCM-side timestamp of this reading. Used to set Balance.lastHcmAsOf. */
  asOf: string; // ISO-8601 datetime string
}

/** Command payload for POST /hcm/timeoff */
export interface FileTimeOffCommand {
  employeeId: string;
  locationId: string;
  /** Business days — always server-computed (§12). */
  days: number;
  /** Inclusive start date (YYYY-MM-DD). */
  startDate: string;
  /** Inclusive end date (YYYY-MM-DD). */
  endDate: string;
  /**
   * Stable idempotency key: `${hcmIdempotencyKey}:FILE`.
   * Reused verbatim on every retry (ADR-008).
   */
  idempotencyKey: string;
}

/** Result from POST /hcm/timeoff */
export interface FileTimeOffResult {
  ok: boolean;
  /**
   * HCM-side acknowledgement timestamp.
   * When present and ok=true, set TimeOffRequest.hcmAckAt (ADR-003).
   */
  ackedAt?: string; // ISO-8601 datetime string
  /**
   * HCM error text — for logging ONLY. Never used as a business decision gate.
   * HCM may return 200 even when the balance is insufficient (ADR-001).
   */
  errorHint?: string;
}

/** Command payload for POST /hcm/timeoff/reverse */
export interface ReverseTimeOffCommand {
  employeeId: string;
  locationId: string;
  days: number;
  startDate: string;
  endDate: string;
  /**
   * Stable idempotency key: `${hcmIdempotencyKey}:REVERSE`.
   * A no-op at HCM if no FILE ever landed (ADR-004/ADR-008).
   */
  idempotencyKey: string;
}

/** Result from POST /hcm/timeoff/reverse */
export interface ReverseTimeOffResult {
  ok: boolean;
  ackedAt?: string;
  errorHint?: string;
}

/**
 * Full batch corpus payload (POST /timeoff/hcm/batch, pushed by HCM → service).
 * `sequence` is monotonic; ingest rejects <= last applied (ADR-009).
 * `asOf` is the replay boundary for ADR-003.
 */
export interface BatchCorpus {
  /** Monotonic integer sequence. ADR-009 dedup guard. */
  sequence: number;
  /** Snapshot timestamp. ADR-003 replay cutoff. ISO-8601 datetime string. */
  asOf: string;
  /** Full snapshot — all (employeeId, locationId) balances as of `asOf`. */
  balances: HcmBalance[];
}
