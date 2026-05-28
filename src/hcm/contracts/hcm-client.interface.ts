import {
  HcmBalance,
  FileTimeOffCommand,
  FileTimeOffResult,
  ReverseTimeOffCommand,
  ReverseTimeOffResult,
} from './hcm.types';

/**
 * Options for getBalance.
 *
 * retry (default: true) — when false, the implementation makes a single
 * attempt with a short per-request timeout and throws HcmUnavailableError
 * immediately on any failure. Use retry:false on read paths that have a
 * local fallback (ADR-014 cold-read, ADR-001 approve refresh) so that HCM
 * downtime degrades fast rather than burning 31 s of retry budget.
 *
 * Write paths (fileTimeOff / reverseTimeOff via OutboxDispatcher) must keep
 * the full retry budget — they have no local fallback.
 */
export interface HcmGetBalanceOptions {
  retry?: boolean;
}

/**
 * HcmClient — interface for all outbound HCM calls.
 *
 * DI token: HCM_CLIENT (defined in hcm.tokens.ts).
 * Production binding: HcmClientService.
 * Test binding: a test double or the in-process mock-hcm module.
 *
 * Implementations MUST:
 * - Retry with exponential backoff up to hcmRetryMaxAttempts (ADR-004).
 * - Pass idempotencyKey as the `Idempotency-Key` HTTP header (ADR-008).
 * - Never throw on HCM error — return { ok: false, errorHint } instead.
 * - Log request/response at structured-log level (no PHI in log values).
 */
export interface HcmClient {
  /**
   * GET /hcm/balance — fetch realtime balance for (employeeId, locationId).
   * Called once per approve (ADR-001 step 1) and during cold-read lazy
   * hydration (ADR-014).
   *
   * Pass opts.retry = false on read paths that have a graceful local fallback
   * so that HCM downtime causes a fast-fail (single attempt, 2500 ms timeout)
   * rather than exhausting the full 31-second retry budget.
   */
  getBalance(employeeId: string, locationId: string, opts?: HcmGetBalanceOptions): Promise<HcmBalance>;

  /**
   * POST /hcm/timeoff — file a time-off deduction against HCM.
   * Idempotent via cmd.idempotencyKey. Called by the OutboxDispatcher.
   */
  fileTimeOff(cmd: FileTimeOffCommand): Promise<FileTimeOffResult>;

  /**
   * POST /hcm/timeoff/reverse — reverse a previous FILE.
   * Idempotent via cmd.idempotencyKey. Called by the OutboxDispatcher for
   * REVERSE outbox rows (cancels, compensating reversals on retry-cap — ADR-004).
   */
  reverseTimeOff(cmd: ReverseTimeOffCommand): Promise<ReverseTimeOffResult>;
}
