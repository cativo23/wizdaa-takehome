/**
 * In-memory store for the Mock HCM server (ADR-007).
 *
 * Keyed by `${employeeId}::${locationId}` → BalanceEntry.
 * Seeded at startup with a handful of employees so the service has something to read.
 */

export interface BalanceEntry {
  employeeId: string;
  locationId: string;
  balance: number;
  asOf: string; // ISO-8601
}

/** All stored balances. */
export const balanceStore = new Map<string, BalanceEntry>();

/** Idempotency-key → stored result (for FILE and REVERSE operations). */
export const idempotencyStore = new Map<string, { ok: boolean; ackedAt: string }>();

/** Monotonic sequence counter for batch emission. */
let currentSequence = 0;

export function getNextSequence(): number {
  return ++currentSequence;
}

export function getCurrentSequence(): number {
  return currentSequence;
}

export function storeKey(employeeId: string, locationId: string): string {
  return `${employeeId}::${locationId}`;
}

/** Active scenario; switches at runtime via POST /_control/scenario */
export type HcmScenario =
  | 'correct'
  | 'silent-insufficient'
  | 'timeout'
  | 'mutate-between-calls'
  | 'divergent-batch'
  | 'duplicate-delivery'
  | 'ignore-idempotency-key';

let activeScenario: HcmScenario = (process.env['HCM_SCENARIO'] as HcmScenario) ?? 'correct';

export function getScenario(): HcmScenario {
  return activeScenario;
}

export function setScenario(scenario: HcmScenario): void {
  activeScenario = scenario;
}

/** Seed initial balances so the main service has data to read on startup. */
function seedBalances(): void {
  const seed: BalanceEntry[] = [
    { employeeId: 'emp1', locationId: 'loc1', balance: 10, asOf: new Date().toISOString() },
    { employeeId: 'emp1', locationId: 'loc2', balance: 5, asOf: new Date().toISOString() },
    { employeeId: 'emp2', locationId: 'loc1', balance: 8, asOf: new Date().toISOString() },
    { employeeId: 'emp3', locationId: 'loc1', balance: 15, asOf: new Date().toISOString() },
    { employeeId: 'emp3', locationId: 'loc2', balance: 3, asOf: new Date().toISOString() },
  ];
  for (const entry of seed) {
    balanceStore.set(storeKey(entry.employeeId, entry.locationId), entry);
  }
}

seedBalances();

/**
 * Reset all module-level store state back to defaults.
 * Intended for test use only — call in beforeEach when the real MockHcmModule
 * is booted in-process, since the Maps are module-level singletons that persist
 * across tests within the same Jest worker.
 */
export function resetMockHcmStore(): void {
  balanceStore.clear();
  idempotencyStore.clear();
  activeScenario = 'correct';
  currentSequence = 0;
  seedBalances();
}
