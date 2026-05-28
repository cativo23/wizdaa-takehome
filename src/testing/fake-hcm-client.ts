/**
 * FakeHcmClient — programmable in-process test double for HcmClient.
 *
 * Bind to the HCM_CLIENT token in a NestJS testing module:
 *   .overrideProvider(HCM_CLIENT).useValue(new FakeHcmClient())
 *
 * Mirrors the 7 ADR-007 scenarios from src/mock-hcm/ so integration tests
 * use the same scenario semantics as the networked mock-hcm service, but
 * with zero I/O overhead.
 */

import type { HcmClient, HcmGetBalanceOptions } from '../hcm/contracts/hcm-client.interface';
import type {
  HcmBalance,
  FileTimeOffCommand,
  FileTimeOffResult,
  ReverseTimeOffCommand,
  ReverseTimeOffResult,
} from '../hcm/contracts/hcm.types';
import { HcmUnavailableError } from '../hcm/hcm.errors';

// Re-export the scenario type so tests can use the narrowed union.
export type HcmScenario =
  | 'correct'
  | 'silent-insufficient'
  | 'timeout'
  | 'mutate-between-calls'
  | 'divergent-batch'
  | 'duplicate-delivery'
  | 'ignore-idempotency-key';

interface StoredBalance {
  balance: number;
  asOf: string; // ISO-8601
}

/**
 * Public spy counters so tests can assert call frequencies without jest.fn().
 */
export interface CallCounters {
  getBalance: number;
  fileTimeOff: number;
  reverseTimeOff: number;
}

export class FakeHcmClient implements HcmClient {
  // ---------------------------------------------------------------------------
  // In-memory state
  // ---------------------------------------------------------------------------

  /** Keyed by `${employeeId}::${locationId}` → { balance, asOf } */
  private readonly store = new Map<string, StoredBalance>();

  /**
   * Idempotency-key dedup table: key → cached result.
   * Honored in all scenarios except `ignore-idempotency-key`.
   */
  private readonly idempotencyStore = new Map<
    string,
    { ok: boolean; ackedAt: string }
  >();

  private scenario: HcmScenario = 'correct';

  /** Per-method call counters for test assertions. */
  readonly callsTo: CallCounters = {
    getBalance: 0,
    fileTimeOff: 0,
    reverseTimeOff: 0,
  };

  // ---------------------------------------------------------------------------
  // Configuration API (called from test setup)
  // ---------------------------------------------------------------------------

  /**
   * Seed a balance for a (employeeId, locationId) pair.
   * If `asOf` is omitted, defaults to the current wall-clock time.
   */
  seedBalance(
    employeeId: string,
    locationId: string,
    balance: number,
    asOf?: string,
  ): void {
    this.store.set(this.storeKey(employeeId, locationId), {
      balance,
      asOf: asOf ?? new Date().toISOString(),
    });
  }

  /**
   * Switch the active scenario.
   * name must be one of the 7 ADR-007 scenario values.
   */
  setScenario(name: HcmScenario): void {
    this.scenario = name;
  }

  /**
   * Reset all state: clear the balance store, idempotency store, scenario
   * (back to 'correct'), and call counters.
   * Call in afterEach if you share a single FakeHcmClient across tests.
   */
  reset(): void {
    this.store.clear();
    this.idempotencyStore.clear();
    this.scenario = 'correct';
    this.callsTo.getBalance = 0;
    this.callsTo.fileTimeOff = 0;
    this.callsTo.reverseTimeOff = 0;
  }

  // ---------------------------------------------------------------------------
  // HcmClient implementation
  // ---------------------------------------------------------------------------

  /**
   * GET /hcm/balance — returns the stored balance.
   *
   * Scenarios:
   * - timeout            → throws HcmUnavailableError (no real delay)
   * - mutate-between-calls → decrements balance by 1 on every call (E10)
   * - all others         → returns stored value (auto-seeds zero on miss)
   *
   * opts is accepted for interface compatibility but intentionally ignored:
   * the fake is already instant and has no retry loop, so retry:false has no
   * observable effect. Production behaviour (fast vs. full retry) is covered by
   * the real-integration spec (src/__tests__/hcm-real-integration.spec.ts).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getBalance(employeeId: string, locationId: string, opts?: HcmGetBalanceOptions): Promise<HcmBalance> {
    this.callsTo.getBalance += 1;

    if (this.scenario === 'timeout') {
      throw new HcmUnavailableError(
        `getBalance:${employeeId}:${locationId}`,
        'FakeHcmClient timeout scenario',
      );
    }

    const key = this.storeKey(employeeId, locationId);
    let entry = this.store.get(key);

    if (!entry) {
      // Auto-provision a zero entry (mirrors mock-hcm behavior)
      entry = { balance: 0, asOf: new Date().toISOString() };
      this.store.set(key, entry);
    }

    if (this.scenario === 'mutate-between-calls') {
      // Simulate a balance change between successive GETs (E10)
      entry.balance = Math.max(0, entry.balance - 1);
      entry.asOf = new Date().toISOString();
    }

    return {
      employeeId,
      locationId,
      balance: entry.balance,
      asOf: entry.asOf,
    };
  }

  /**
   * POST /hcm/timeoff — file a time-off deduction.
   *
   * Scenarios:
   * - correct              → deducts balance; idempotency dedup applies.
   * - silent-insufficient  → returns { ok: true } WITHOUT deducting (E3).
   *                          Local guard must have already rejected; if reached,
   *                          local state becomes inconsistent until reconciled.
   * - timeout              → returns { ok: false, errorHint: 'unreachable' }
   * - duplicate-delivery   → idempotency dedup still applies (same as correct).
   * - ignore-idempotency-key → skips dedup, applies every call (ADR-008 probe).
   * - mutate-between-calls → behaves like correct.
   * - divergent-batch      → behaves like correct (divergence is in batch corpus).
   */
  async fileTimeOff(cmd: FileTimeOffCommand): Promise<FileTimeOffResult> {
    this.callsTo.fileTimeOff += 1;

    if (this.scenario === 'timeout') {
      return { ok: false, errorHint: 'unreachable' };
    }

    const shouldDedup = this.scenario !== 'ignore-idempotency-key';

    if (shouldDedup) {
      const prior = this.idempotencyStore.get(cmd.idempotencyKey);
      if (prior) {
        return { ok: prior.ok, ackedAt: prior.ackedAt };
      }
    }

    if (this.scenario === 'silent-insufficient') {
      // Return ok=true without actually deducting (E3 — local guard must have fired)
      const ackedAt = new Date().toISOString();
      if (shouldDedup) {
        this.idempotencyStore.set(cmd.idempotencyKey, { ok: true, ackedAt });
      }
      return { ok: true, ackedAt };
    }

    // Normal path: correct / duplicate-delivery / mutate-between-calls / divergent-batch
    const key = this.storeKey(cmd.employeeId, cmd.locationId);
    const entry = this.store.get(key);

    if (!entry) {
      const result = { ok: false, ackedAt: '' };
      if (shouldDedup) {
        this.idempotencyStore.set(cmd.idempotencyKey, result);
      }
      return { ok: false, errorHint: 'Employee/location not found' };
    }

    if (entry.balance < cmd.days) {
      const result = { ok: false, ackedAt: '' };
      if (shouldDedup) {
        this.idempotencyStore.set(cmd.idempotencyKey, result);
      }
      return { ok: false, errorHint: 'Insufficient balance' };
    }

    entry.balance -= cmd.days;
    entry.asOf = new Date().toISOString();

    const ackedAt = new Date().toISOString();
    if (shouldDedup) {
      this.idempotencyStore.set(cmd.idempotencyKey, { ok: true, ackedAt });
    }
    return { ok: true, ackedAt };
  }

  /**
   * POST /hcm/timeoff/reverse — reverse a previous file.
   *
   * A reverse with no prior FILE is a no-op ack (ADR-004/ADR-008).
   *
   * Scenarios:
   * - correct              → credits balance; idempotency dedup applies.
   * - timeout              → returns { ok: false, errorHint: 'unreachable' }
   * - ignore-idempotency-key → skips dedup, applies every call.
   * - all others           → same as correct.
   */
  async reverseTimeOff(cmd: ReverseTimeOffCommand): Promise<ReverseTimeOffResult> {
    this.callsTo.reverseTimeOff += 1;

    if (this.scenario === 'timeout') {
      return { ok: false, errorHint: 'unreachable' };
    }

    const shouldDedup = this.scenario !== 'ignore-idempotency-key';

    if (shouldDedup) {
      const prior = this.idempotencyStore.get(cmd.idempotencyKey);
      if (prior) {
        return { ok: prior.ok, ackedAt: prior.ackedAt };
      }
    }

    const ackedAt = new Date().toISOString();
    const key = this.storeKey(cmd.employeeId, cmd.locationId);
    const entry = this.store.get(key);

    if (!entry) {
      // No-op ack — mirrors mock-hcm behavior (ADR-004)
      if (shouldDedup) {
        this.idempotencyStore.set(cmd.idempotencyKey, { ok: true, ackedAt });
      }
      return { ok: true, ackedAt };
    }

    entry.balance += cmd.days;
    entry.asOf = new Date().toISOString();

    if (shouldDedup) {
      this.idempotencyStore.set(cmd.idempotencyKey, { ok: true, ackedAt });
    }
    return { ok: true, ackedAt };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private storeKey(employeeId: string, locationId: string): string {
    return `${employeeId}::${locationId}`;
  }
}
