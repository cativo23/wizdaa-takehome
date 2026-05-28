import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  HcmClient,
  HcmGetBalanceOptions,
} from './contracts/hcm-client.interface.js';
import {
  HcmBalance,
  FileTimeOffCommand,
  FileTimeOffResult,
  ReverseTimeOffCommand,
  ReverseTimeOffResult,
} from './contracts/hcm.types.js';
import { AppConfigService } from '../config/app-config.service.js';
import { HcmUnavailableError } from './hcm.errors.js';

/**
 * Per-request timeout (ms) used when opts.retry === false.
 * Chosen to be well under the typical user-facing SLA for read paths that
 * have a local fallback (ADR-014 / ADR-001).
 */
const NO_RETRY_TIMEOUT_MS = 2500;

/**
 * HcmClientService — production implementation of HcmClient.
 *
 * Bound to the HCM_CLIENT token in HcmModule.
 *
 * Responsibilities:
 * - HTTP calls to HCM_BASE_URL via @nestjs/axios HttpService.
 * - Retry with exponential backoff up to hcmRetryMaxAttempts (ADR-004).
 * - Pass idempotencyKey as `Idempotency-Key` header (ADR-008).
 * - getBalance THROWS HcmUnavailableError when all retries fail — the approve
 *   path must detect "HCM down" to branch to PENDING_SYNC (ADR-001/ADR-004).
 * - fileTimeOff / reverseTimeOff RETURN { ok: false, errorHint } on any error —
 *   never throw (ADR-001: HCM errors are a hint, not a guarantee).
 * - Never log PHI — only IDs and operation names at debug level (§12).
 */
@Injectable()
export class HcmClientService implements HcmClient {
  private readonly logger = new Logger(HcmClientService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: AppConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * GET /hcm/balance?employeeId=&locationId=
   *
   * Default (opts.retry !== false):
   *   Retries on network errors and 5xx responses with exponential backoff up to
   *   hcmRetryMaxAttempts. A business-level 4xx is escalated immediately.
   *   THROWS HcmUnavailableError when every attempt fails.
   *
   * Fast-fail (opts.retry === false):
   *   Single attempt with a 2500 ms per-request axios timeout. Any failure
   *   (network, timeout, 5xx, 4xx) immediately throws HcmUnavailableError.
   *   Use this on read paths that have a local fallback (ADR-014 cold-read,
   *   ADR-001 approve refresh) to avoid burning the 31-second retry budget
   *   when the caller can degrade gracefully.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    opts?: HcmGetBalanceOptions,
  ): Promise<HcmBalance> {
    const url = `${this.config.hcmBaseUrl}/hcm/balance`;
    const operationId = `getBalance:${employeeId}:${locationId}`;

    if (opts?.retry === false) {
      // Fast-fail path: single attempt, short timeout, no backoff.
      try {
        this.logger.debug(
          `[HCM] getBalance fast-fail attempt=1 employee=${employeeId} location=${locationId}`,
        );

        const response = await firstValueFrom(
          this.http.get<HcmBalance>(url, {
            params: { employeeId, locationId },
            timeout: NO_RETRY_TIMEOUT_MS,
          }),
        );

        this.logger.debug(
          `[HCM] getBalance fast-fail ok employee=${employeeId} location=${locationId}`,
        );

        return response.data;
      } catch (err) {
        // Any failure on the fast-fail path → immediately signal unavailable.
        throw new HcmUnavailableError(operationId, err);
      }
    }

    // Default path: full retry budget with exponential backoff.
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < this.config.hcmRetryMaxAttempts;
      attempt++
    ) {
      if (attempt > 0) {
        await this.backoffDelay(attempt);
      }

      try {
        this.logger.debug(
          `[HCM] getBalance attempt=${attempt + 1} employee=${employeeId} location=${locationId}`,
        );

        const response = await firstValueFrom(
          this.http.get<HcmBalance>(url, {
            params: { employeeId, locationId },
          }),
        );

        this.logger.debug(
          `[HCM] getBalance ok attempt=${attempt + 1} employee=${employeeId} location=${locationId}`,
        );

        return response.data;
      } catch (err) {
        lastError = err;

        if (!this.isRetryable(err)) {
          // 4xx business error — not retriable; escalate immediately.
          throw new HcmUnavailableError(operationId, err);
        }

        this.logger.debug(
          `[HCM] getBalance retryable-error attempt=${attempt + 1}/${this.config.hcmRetryMaxAttempts} employee=${employeeId} location=${locationId}`,
        );
      }
    }

    throw new HcmUnavailableError(operationId, lastError);
  }

  /**
   * POST /hcm/timeoff
   *
   * Retries on network / 5xx with exponential backoff, reusing
   * cmd.idempotencyKey verbatim on every retry (ADR-008).
   *
   * RETURNS { ok: false, errorHint } on any error — never throws.
   */
  async fileTimeOff(cmd: FileTimeOffCommand): Promise<FileTimeOffResult> {
    const url = `${this.config.hcmBaseUrl}/hcm/timeoff`;

    return this.postWithRetry<FileTimeOffResult>(
      url,
      cmd,
      cmd.idempotencyKey,
      'fileTimeOff',
    );
  }

  /**
   * POST /hcm/timeoff/reverse
   *
   * Same idempotency + retry semantics as fileTimeOff.
   * A reverse with no prior FILE is a safe no-op ack at HCM.
   *
   * RETURNS { ok: false, errorHint } on any error — never throws.
   */
  async reverseTimeOff(
    cmd: ReverseTimeOffCommand,
  ): Promise<ReverseTimeOffResult> {
    const url = `${this.config.hcmBaseUrl}/hcm/timeoff/reverse`;

    return this.postWithRetry<ReverseTimeOffResult>(
      url,
      cmd,
      cmd.idempotencyKey,
      'reverseTimeOff',
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Shared retry loop for fileTimeOff and reverseTimeOff.
   *
   * On business 4xx: return { ok: false, errorHint } immediately (no retry).
   * On network/5xx after all attempts: return { ok: false, errorHint: 'unreachable' }.
   * On success: return { ok: true, ackedAt }.
   */
  private async postWithRetry<
    T extends { ok: boolean; ackedAt?: string; errorHint?: string },
  >(
    url: string,
    body: unknown,
    idempotencyKey: string,
    operation: string,
  ): Promise<T> {
    let lastHint = 'unreachable';

    for (
      let attempt = 0;
      attempt < this.config.hcmRetryMaxAttempts;
      attempt++
    ) {
      if (attempt > 0) {
        await this.backoffDelay(attempt);
      }

      try {
        this.logger.debug(
          `[HCM] ${operation} attempt=${attempt + 1} idempotencyKey=${idempotencyKey}`,
        );

        const response = await firstValueFrom(
          this.http.post<T>(url, body, {
            headers: { 'Idempotency-Key': idempotencyKey },
          }),
        );

        this.logger.debug(
          `[HCM] ${operation} ok attempt=${attempt + 1} idempotencyKey=${idempotencyKey}`,
        );

        const data = response.data;

        // Propagate body.ok: a 2xx with ok=false is a business-level rejection (e.g.
        // insufficient balance reported after filing). Never retry these — the HCM
        // already processed the request and rejected it for a domain reason.
        if (data.ok === false) {
          this.logger.debug(
            `[HCM] ${operation} business-rejected (2xx ok=false) idempotencyKey=${idempotencyKey} hint=${data.errorHint ?? 'hcm-rejected'}`,
          );
          return {
            ok: false,
            errorHint: data.errorHint ?? 'hcm-rejected',
          } as T;
        }

        if (data.ok === undefined) {
          this.logger.warn(
            `[HCM] ${operation} response missing ok field — treating as success; possible contract drift idempotencyKey=${idempotencyKey}`,
          );
        }

        return {
          ok: true,
          ackedAt: data.ackedAt ?? new Date().toISOString(),
        } as T;
      } catch (err) {
        if (!this.isRetryable(err)) {
          // Business-level 4xx: HCM says the operation is invalid.
          // Return the error hint — never throw (ADR-001).
          const hint = this.extractErrorHint(err);
          this.logger.debug(
            `[HCM] ${operation} business-error idempotencyKey=${idempotencyKey} hint=${hint}`,
          );
          return { ok: false, errorHint: hint } as T;
        }

        lastHint = this.extractErrorHint(err) ?? 'unreachable';
        this.logger.debug(
          `[HCM] ${operation} retryable-error attempt=${attempt + 1}/${this.config.hcmRetryMaxAttempts} idempotencyKey=${idempotencyKey}`,
        );
      }
    }

    // All attempts exhausted.
    return { ok: false, errorHint: lastHint } as T;
  }

  /**
   * Compute the delay for a given retry attempt (0-indexed, called with attempt >= 1).
   *
   * Delay = hcmRetryBackoffMs * 2^(attempt - 1)
   *   attempt=1 → base * 1
   *   attempt=2 → base * 2
   *   attempt=3 → base * 4
   *
   * Extracted into its own method so unit tests can spy/mock it to avoid
   * real sleeping (jest.spyOn(service, 'backoffDelay').mockResolvedValue()).
   */
  protected backoffDelay(attempt: number): Promise<void> {
    const ms = this.config.hcmRetryBackoffMs * Math.pow(2, attempt - 1);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns true if the error should trigger a retry.
   * Network errors (no response) and 5xx responses are retryable.
   * 4xx responses are not (business error, no point retrying).
   */
  private isRetryable(err: unknown): boolean {
    if (err instanceof AxiosError) {
      // No response at all = network/timeout error → retry.
      if (!err.response) return true;
      // 5xx = server-side transient error → retry.
      return err.response.status >= 500;
    }
    // Non-Axios errors: treat as retryable (unexpected, could be transient).
    return true;
  }

  /**
   * Extract a short human-readable error hint from an Axios error.
   * Never includes any PHI — only status codes and generic messages.
   */
  private extractErrorHint(err: unknown): string {
    if (err instanceof AxiosError) {
      if (err.response) {
        const data = err.response.data as Record<string, unknown> | undefined;
        const serverMessage =
          typeof data?.message === 'string' ? data.message : undefined;
        return serverMessage ?? `http_${err.response.status}`;
      }
      return err.code ?? 'network_error';
    }
    return 'unknown_error';
  }
}
