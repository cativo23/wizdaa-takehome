import {
  HcmBalance,
  FileTimeOffCommand,
  FileTimeOffResult,
  ReverseTimeOffCommand,
  ReverseTimeOffResult,
} from './hcm.types';

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
   * Called once per approve (ADR-001 step 1).
   */
  getBalance(employeeId: string, locationId: string): Promise<HcmBalance>;

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
