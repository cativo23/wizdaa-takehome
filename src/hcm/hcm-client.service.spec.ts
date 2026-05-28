/**
 * hcm-client.service.spec.ts — unit tests for HcmClientService.
 *
 * Strategy: instantiate HcmClientService directly (no NestJS module).
 * Inject a mock HttpService and stub AppConfigService.
 * Spy on `backoffDelay` to keep tests fast (no real sleeping).
 */

import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { HcmClientService } from './hcm-client.service';
import { HcmUnavailableError } from './hcm.errors';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<{ hcmRetryMaxAttempts: number; hcmRetryBackoffMs: number }> = {}) {
  return {
    hcmBaseUrl: 'http://test',
    hcmRetryMaxAttempts: overrides.hcmRetryMaxAttempts ?? 3,
    hcmRetryBackoffMs: overrides.hcmRetryBackoffMs ?? 1,
  } as any;
}

/** Build a minimal mock HttpService. */
function makeHttpService() {
  return {
    get: jest.fn(),
    post: jest.fn(),
  } as any;
}

/** Wrap data in a successful Axios response Observable. */
function okResponse<T>(data: T) {
  return of({ data } as AxiosResponse<T>);
}

/** Network-level error (no response object). */
function networkError(code = 'ECONNREFUSED'): AxiosError {
  const err = new AxiosError('Network Error');
  err.code = code;
  return err;
}

/** HTTP error with a response status code. */
function httpError(status: number, message?: string): AxiosError {
  const err = new AxiosError(`Request failed with status code ${status}`);
  (err as any).response = {
    status,
    data: message ? { message } : {},
  };
  return err;
}

/** Build HcmClientService with backoffDelay mocked out (no real sleeping). */
function buildService(http: any, config = makeConfig()) {
  const svc = new HcmClientService(http, config);
  jest.spyOn(svc as any, 'backoffDelay').mockResolvedValue(undefined);
  return svc;
}

// ---------------------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------------------

describe('HcmClientService.getBalance', () => {
  it('happy path: returns HcmBalance and makes exactly one HTTP call', async () => {
    const expected = {
      employeeId: 'emp1',
      locationId: 'loc1',
      balance: 10,
      asOf: '2026-06-01T00:00:00Z',
    };
    const http = makeHttpService();
    http.get.mockReturnValue(okResponse(expected));
    const svc = buildService(http);

    const result = await svc.getBalance('emp1', 'loc1');

    expect(result).toEqual(expected);
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith(
      'http://test/hcm/balance',
      expect.objectContaining({ params: { employeeId: 'emp1', locationId: 'loc1' } }),
    );
  });

  it('network failure: retries hcmRetryMaxAttempts times then throws HcmUnavailableError', async () => {
    const maxAttempts = 3;
    const http = makeHttpService();
    http.get.mockReturnValue(throwError(() => networkError()));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: maxAttempts }));

    await expect(svc.getBalance('emp1', 'loc1')).rejects.toBeInstanceOf(HcmUnavailableError);
    expect(http.get).toHaveBeenCalledTimes(maxAttempts);
  });

  it('4xx response: throws HcmUnavailableError immediately without retrying', async () => {
    const http = makeHttpService();
    http.get.mockReturnValue(throwError(() => httpError(404)));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: 3 }));

    await expect(svc.getBalance('emp1', 'loc1')).rejects.toBeInstanceOf(HcmUnavailableError);
    // 4xx is NOT retryable → only one attempt
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fileTimeOff
// ---------------------------------------------------------------------------

describe('HcmClientService.fileTimeOff', () => {
  const cmd = {
    employeeId: 'emp1',
    locationId: 'loc1',
    days: 2,
    startDate: '2026-06-01',
    endDate: '2026-06-02',
    idempotencyKey: 'idem-key-abc123',
  };

  it('happy path: returns { ok: true, ackedAt } and sends Idempotency-Key header', async () => {
    const hcmBody = { ok: true, ackedAt: '2026-06-01T12:00:00Z' };
    const http = makeHttpService();
    http.post.mockReturnValue(okResponse(hcmBody));
    const svc = buildService(http);

    const result = await svc.fileTimeOff(cmd);

    expect(result.ok).toBe(true);
    expect(result.ackedAt).toBeDefined();
    expect(http.post).toHaveBeenCalledTimes(1);

    const [, , options] = http.post.mock.calls[0];
    expect(options.headers['Idempotency-Key']).toBe(cmd.idempotencyKey);
  });

  it('network failure: retries to cap, returns { ok: false, errorHint } without throwing', async () => {
    const maxAttempts = 3;
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => networkError('ETIMEDOUT')));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: maxAttempts }));

    const result = await svc.fileTimeOff(cmd);

    expect(result.ok).toBe(false);
    expect(result.errorHint).toBeDefined();
    expect(http.post).toHaveBeenCalledTimes(maxAttempts);
  });

  it('4xx business error: returns { ok: false, errorHint } immediately without retrying', async () => {
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => httpError(422, 'invalid dates')));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: 3 }));

    const result = await svc.fileTimeOff(cmd);

    expect(result.ok).toBe(false);
    expect(result.errorHint).toBe('invalid dates');
    // 4xx is NOT retryable → only one attempt
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('5xx server error: retries to cap then returns { ok: false }', async () => {
    const maxAttempts = 3;
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => httpError(503)));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: maxAttempts }));

    const result = await svc.fileTimeOff(cmd);

    expect(result.ok).toBe(false);
    // 5xx is retryable → should attempt maxAttempts times
    expect(http.post).toHaveBeenCalledTimes(maxAttempts);
  });

  it('returns {ok:false} when HCM returns 200 with body.ok=false (silent-insufficient)', async () => {
    const http = makeHttpService();
    http.post.mockReturnValue(
      of({ status: 200, data: { ok: false, errorHint: 'insufficient' } } as any),
    );
    const svc = buildService(http);
    const backoffSpy = jest.spyOn(svc as any, 'backoffDelay');

    const result = await svc.fileTimeOff(cmd);

    expect(result.ok).toBe(false);
    expect(result.errorHint).toBe('insufficient');
    // Business rejection — no retries fired
    expect(backoffSpy).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// reverseTimeOff
// ---------------------------------------------------------------------------

describe('HcmClientService.reverseTimeOff', () => {
  const cmd = {
    employeeId: 'emp1',
    locationId: 'loc1',
    days: 2,
    startDate: '2026-06-01',
    endDate: '2026-06-02',
    idempotencyKey: 'reverse-idem-key-xyz',
  };

  it('happy path: returns { ok: true, ackedAt } and sends Idempotency-Key header to /hcm/timeoff/reverse', async () => {
    const hcmBody = { ok: true, ackedAt: '2026-06-02T08:00:00Z' };
    const http = makeHttpService();
    http.post.mockReturnValue(okResponse(hcmBody));
    const svc = buildService(http);

    const result = await svc.reverseTimeOff(cmd);

    expect(result.ok).toBe(true);
    expect(result.ackedAt).toBeDefined();
    expect(http.post).toHaveBeenCalledTimes(1);

    const [url, , options] = http.post.mock.calls[0];
    expect(url).toContain('/hcm/timeoff/reverse');
    expect(options.headers['Idempotency-Key']).toBe(cmd.idempotencyKey);
  });

  it('network failure: retries to cap, returns { ok: false } without throwing', async () => {
    const maxAttempts = 3;
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => networkError()));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: maxAttempts }));

    const result = await svc.reverseTimeOff(cmd);

    expect(result.ok).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(maxAttempts);
  });

  it('4xx business error: returns { ok: false } immediately without retrying', async () => {
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => httpError(400, 'bad request')));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: 3 }));

    const result = await svc.reverseTimeOff(cmd);

    expect(result.ok).toBe(false);
    expect(result.errorHint).toBe('bad request');
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Coverage gap-fill: branches not exercised by the main suites above
// ---------------------------------------------------------------------------

describe('HcmClientService — coverage edge branches', () => {
  it('getBalance retry:false success path: returns HcmBalance in a single fast-fail attempt', async () => {
    const expected = {
      employeeId: 'emp1',
      locationId: 'loc1',
      balance: 5,
      asOf: '2026-06-01T00:00:00Z',
    };
    const http = makeHttpService();
    http.get.mockReturnValue(of({ data: expected } as any));
    const svc = buildService(http);

    const result = await svc.getBalance('emp1', 'loc1', { retry: false });

    expect(result).toEqual(expected);
    expect(http.get).toHaveBeenCalledTimes(1);
    const [, opts] = http.get.mock.calls[0];
    expect(opts).toMatchObject({ timeout: 2500 });
  });

  it('postWithRetry: 200 response with ok=undefined is treated as success (warn path)', async () => {
    const http = makeHttpService();
    const ackedAt = '2026-06-01T10:00:00Z';
    // ok field absent from response
    http.post.mockReturnValue(of({ data: { ackedAt } } as any));
    const svc = buildService(http);

    const result = await svc.fileTimeOff({
      employeeId: 'emp1',
      locationId: 'loc1',
      days: 1,
      startDate: '2026-06-02',
      endDate: '2026-06-02',
      idempotencyKey: 'key-ok-undefined',
    });

    expect(result.ok).toBe(true);
    expect(result.ackedAt).toBe(ackedAt);
  });

  it('non-Axios error in fileTimeOff: treated as retryable, exhausts attempts, returns {ok:false,errorHint:"unknown_error"}', async () => {
    const maxAttempts = 2;
    const http = makeHttpService();
    http.post.mockReturnValue(throwError(() => new Error('unexpected non-axios')));
    const svc = buildService(http, makeConfig({ hcmRetryMaxAttempts: maxAttempts }));

    const result = await svc.fileTimeOff({
      employeeId: 'emp1',
      locationId: 'loc1',
      days: 1,
      startDate: '2026-06-02',
      endDate: '2026-06-02',
      idempotencyKey: 'key-non-axios',
    });

    expect(result.ok).toBe(false);
    expect(result.errorHint).toBe('unknown_error');
    expect(http.post).toHaveBeenCalledTimes(maxAttempts);
  });

  it('backoffDelay resolves after the configured delay (live — not mocked)', async () => {
    const http = makeHttpService();
    const config = makeConfig({ hcmRetryBackoffMs: 1 });
    const svc = new HcmClientService(http, config as any);

    // Call backoffDelay directly (protected — cast to any)
    await expect((svc as any).backoffDelay(1)).resolves.toBeUndefined();
  });
});
