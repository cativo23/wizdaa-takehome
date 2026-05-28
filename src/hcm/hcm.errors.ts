/**
 * Typed errors for the HCM client layer.
 *
 * Only HcmUnavailableError is thrown — and only from getBalance, where the
 * approve path must detect "HCM is down" to decide between APPROVED and
 * PENDING_SYNC.  fileTimeOff / reverseTimeOff always return { ok: false }
 * instead of throwing (ADR-001).
 */

/**
 * Thrown by HcmClientService.getBalance when HCM is unreachable after all
 * retry attempts (network error or 5xx on every attempt).
 *
 * Callers that receive this error must treat HCM as temporarily unavailable
 * and branch accordingly (e.g. transition the request to PENDING_SYNC rather
 * than failing hard).
 */
export class HcmUnavailableError extends Error {
  readonly operationId: string;

  constructor(operationId: string, cause?: unknown) {
    super(
      `HCM unavailable after all retry attempts (operation=${operationId})`,
    );
    this.name = 'HcmUnavailableError';
    this.operationId = operationId;

    // Preserve the original cause for logging / test inspection.
    if (cause !== undefined) {
      // `cause` is part of the Error options spec (ES2022), supported here via
      // manual assignment for TS targets that may not have it natively.
      (this as unknown as Record<string, unknown>)['cause'] = cause;
    }

    // Restore prototype chain when transpiling to ES5.
    Object.setPrototypeOf(this, HcmUnavailableError.prototype);
  }
}
