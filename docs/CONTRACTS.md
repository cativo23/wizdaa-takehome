# CONTRACTS.md — Contract Freeze for Parallel Agent Build

**Status:** Frozen (contract-freeze phase)
**Date:** 2026-05-27
**Purpose:** Single source of truth for every downstream agent filling method bodies.
Read this file (plus TRD.md) to understand what you must implement. Do NOT change
any interface, token, method signature, or module wiring defined here — only fill
`throw new Error('NotImplemented: ...')` bodies.

---

## 1. File Tree

```
src/
├── main.ts                            -- entry point; ValidationPipe registered globally
├── app.module.ts                      -- root module; imports all domain modules
│
├── config/
│   ├── app-config.service.ts          -- REAL — typed env var accessor
│   └── config.module.ts               -- REAL — global, wraps @nestjs/config
│
├── database/
│   └── database.module.ts             -- REAL — TypeOrmModule.forRootAsync + buildDataSourceOptions()
│
├── entities/
│   ├── enums.ts                       -- REAL — all domain enums
│   ├── balance.entity.ts              -- REAL — Balance entity
│   ├── time-off-request.entity.ts     -- REAL — TimeOffRequest entity
│   ├── outbox.entity.ts               -- REAL — Outbox entity
│   ├── batch-sync-log.entity.ts       -- REAL — BatchSyncLog entity
│   ├── reconciliation-event.entity.ts -- REAL — ReconciliationEvent entity
│   └── index.ts                       -- REAL — barrel export
│
├── common/
│   ├── clock/
│   │   ├── clock.interface.ts         -- REAL — Clock { now(): Date }
│   │   ├── clock.tokens.ts            -- REAL — CLOCK token
│   │   ├── system-clock.ts            -- REAL — production Clock
│   │   ├── fake-clock.ts              -- REAL — test Clock (setNow, advance)
│   │   └── clock.module.ts            -- REAL — global, binds SystemClock → CLOCK
│   └── lock/
│       ├── balance-lock.service.ts    -- REAL — BalanceLockService + balanceKey()
│       └── lock.module.ts             -- REAL — global, provides BalanceLockService
│
├── hcm/
│   ├── contracts/
│   │   ├── hcm.types.ts               -- REAL — wire types (HcmBalance, BatchCorpus, etc.)
│   │   └── hcm-client.interface.ts    -- REAL — HcmClient interface
│   ├── hcm.tokens.ts                  -- REAL — HCM_CLIENT token
│   ├── hcm-client.service.ts          -- SKELETON — Phase 1 fills bodies
│   ├── outbox-dispatcher.service.ts   -- SKELETON — Phase 1 fills bodies
│   └── hcm.module.ts                  -- REAL — wires HCM_CLIENT + OutboxDispatcher
│
├── balance/
│   ├── dto/
│   │   ├── get-balance.dto.ts         -- REAL — query DTO for GET /balances
│   │   └── resolve-review.dto.ts      -- REAL — body DTO for PATCH /balances/resolve-review
│   ├── balance.service.ts             -- SKELETON — Phase 1 fills bodies
│   ├── balance.controller.ts          -- REAL (thin delegation, IDOR checks)
│   └── balance.module.ts              -- REAL
│
├── time-off-request/
│   ├── dto/
│   │   ├── submit-request.dto.ts      -- REAL — body DTO (no `days` field)
│   │   ├── approve-request.dto.ts     -- REAL
│   │   ├── reject-request.dto.ts      -- REAL
│   │   └── cancel-request.dto.ts      -- REAL
│   ├── time-off-request.service.ts    -- SKELETON — Phase 1 fills bodies
│   ├── time-off-request.controller.ts -- REAL (thin delegation, auth checks)
│   └── time-off-request.module.ts     -- REAL
│
├── reconciliation/
│   ├── dto/
│   │   └── batch-corpus.dto.ts        -- REAL — validated batch ingest DTO
│   ├── reconciliation.service.ts      -- SKELETON — Phase 1 fills bodies
│   ├── batch.controller.ts            -- REAL (thin delegation)
│   └── reconciliation.module.ts       -- REAL
│
├── reservation-reaper/
│   ├── reservation-reaper.service.ts  -- SKELETON — Phase 1 fills bodies
│   └── reservation-reaper.module.ts   -- REAL
│
└── health/
    └── health.controller.ts           -- REAL — GET / returns { status: 'ok' }
```

---

## 2. Entities

### Balance (`src/entities/balance.entity.ts`)
Table: `balances`

| Column       | Type       | Notes                                              |
|--------------|------------|----------------------------------------------------|
| employeeId   | varchar    | Composite PK (part 1)                              |
| locationId   | varchar    | Composite PK (part 2)                              |
| available    | integer    | Days free to reserve; default 0                    |
| reserved     | integer    | Days held by PENDING/PENDING_SYNC; default 0       |
| needsReview  | boolean    | Set when reconciliation yields negative (ADR-003)  |
| version      | integer    | @VersionColumn — optimistic lock (ADR-005)         |
| lastHcmAsOf  | datetime   | nullable; asOf of last applied HCM snapshot        |
| createdAt    | datetime   | @CreateDateColumn                                  |
| updatedAt    | datetime   | @UpdateDateColumn                                  |

### TimeOffRequest (`src/entities/time-off-request.entity.ts`)
Table: `time_off_requests`

| Column           | Type     | Notes                                                        |
|------------------|----------|--------------------------------------------------------------|
| id               | uuid     | PK, @PrimaryGeneratedColumn('uuid')                         |
| employeeId       | varchar  |                                                              |
| locationId       | varchar  |                                                              |
| startDate        | varchar  | YYYY-MM-DD; inclusive                                        |
| endDate          | varchar  | YYYY-MM-DD; inclusive                                        |
| days             | integer  | Server-computed, never client-supplied (§12)                |
| status           | varchar  | RequestStatus enum                                           |
| idempotencyKey   | varchar  | UNIQUE; ADR-012 active-state scoping in app logic           |
| hcmIdempotencyKey| varchar  | Stable key for HCM calls; allocated at creation (ADR-008)   |
| expiresAt        | datetime | Reservation TTL (ADR-002)                                    |
| version          | integer  | @VersionColumn — optimistic lock (ADR-005)                   |
| committedAt      | datetime | nullable; set when status → APPROVED                        |
| hcmAckAt         | datetime | nullable; when HCM acked FILE/REVERSE (ADR-003 replay key)  |
| createdAt        | datetime | @CreateDateColumn                                            |
| updatedAt        | datetime | @UpdateDateColumn                                            |

### Outbox (`src/entities/outbox.entity.ts`)
Table: `outbox`

| Column         | Type        | Notes                                                     |
|----------------|-------------|-----------------------------------------------------------|
| id             | uuid        | PK                                                        |
| aggregateId    | varchar     | requestId (FK by convention, no FK constraint in SQLite)  |
| operation      | varchar     | OutboxOperation enum (FILE \| REVERSE)                    |
| payload        | simple-json | Full command payload to pass to HcmClient                 |
| idempotencyKey | varchar     | `${hcmIdempotencyKey}:${operation}` (ADR-008)             |
| status         | varchar     | OutboxStatus enum; default PENDING                        |
| attempts       | integer     | Delivery attempt count; default 0                         |
| createdAt      | datetime    | @CreateDateColumn                                         |

### BatchSyncLog (`src/entities/batch-sync-log.entity.ts`)
Table: `batch_sync_log`

| Column    | Type     | Notes                                  |
|-----------|----------|----------------------------------------|
| sequence  | integer  | Monotonic PK from HCM (ADR-009)        |
| asOf      | datetime | HCM snapshot timestamp (replay cutoff) |
| appliedAt | datetime | @CreateDateColumn                      |

### ReconciliationEvent (`src/entities/reconciliation-event.entity.ts`)
Table: `reconciliation_events` — append-only

| Column     | Type    | Notes                        |
|------------|---------|------------------------------|
| id         | uuid    | PK                           |
| employeeId | varchar |                              |
| locationId | varchar |                              |
| localValue | integer | available before reconcile   |
| hcmValue   | integer | value from HCM snapshot      |
| resolution | varchar | ReconResolution enum         |
| createdAt  | datetime| @CreateDateColumn            |

---

## 3. Enums (`src/entities/enums.ts`)

```ts
enum RequestStatus   { DRAFT, PENDING, PENDING_SYNC, APPROVED, REJECTED, CANCELLED, EXPIRED }
enum OutboxOperation { FILE, REVERSE }
enum OutboxStatus    { PENDING, SENT, FAILED, VOIDED }
enum ReconResolution { REPLAYED, FLAGGED_NEGATIVE, NO_CHANGE, STALE_REJECTED }

const TERMINAL_STATUSES: ReadonlySet<RequestStatus>  // REJECTED | CANCELLED | EXPIRED
const ACTIVE_STATUSES: ReadonlySet<RequestStatus>    // DRAFT | PENDING | PENDING_SYNC | APPROVED
```

---

## 4. DI Tokens

| Token          | File                            | Bound to                    | Notes                                    |
|----------------|---------------------------------|-----------------------------|------------------------------------------|
| `CLOCK`        | `common/clock/clock.tokens.ts`  | `SystemClock` (production)  | Override in tests with `FakeClock`       |
| `HCM_CLIENT`   | `hcm/hcm.tokens.ts`             | `HcmClientService`          | Override in tests with a test double     |

Both tokens are plain strings (`'CLOCK'`, `'HCM_CLIENT'`).

---

## 5. AppConfigService API (`src/config/app-config.service.ts`)

All properties are getters — read from `ConfigService`, never throw.

| Getter                  | Type    | Default                     | Env var                       |
|-------------------------|---------|-----------------------------|-------------------------------|
| databasePath            | string  | `/app/data/timeoff.sqlite`  | `DATABASE_PATH`               |
| hcmBaseUrl              | string  | `http://localhost:3001`     | `HCM_BASE_URL`                |
| reservationTtlDays      | number  | `14`                        | `RESERVATION_TTL_DAYS`        |
| hcmRetryMaxAttempts     | number  | `5`                         | `HCM_RETRY_MAX_ATTEMPTS`      |
| hcmRetryBackoffMs       | number  | `1000`                      | `HCM_RETRY_BACKOFF_MS`        |
| port                    | number  | `3000`                      | `PORT`                        |
| balanceLazyLoadEnabled  | boolean | `true`                      | `BALANCE_LAZY_LOAD_ENABLED`   |

---

## 6. Database Helper (`src/database/database.module.ts`)

```ts
function buildDataSourceOptions(overrides?: Partial<DataSourceOptions>): DataSourceOptions
```

Produces TypeORM DataSourceOptions with `type: 'better-sqlite3'` and all 5 entities registered.
Production database path comes from `AppConfigService.databasePath`.

**Test harness usage:**
```ts
import { buildDataSourceOptions } from './src/database/database.module';

const opts = buildDataSourceOptions({
  database: ':memory:',
  synchronize: true,
  dropSchema: true,
});
```
Pass `opts` to `TypeOrmModule.forRoot(opts)` in your `Test.createTestingModule`.

---

## 7. Clock API (`src/common/clock/`)

### Interface
```ts
interface Clock { now(): Date; }
```

### SystemClock (production)
```ts
class SystemClock implements Clock { now(): Date; }
```
Bound to `CLOCK` token by `ClockModule` (global).

### FakeClock (tests)
```ts
class FakeClock implements Clock {
  constructor(initial?: Date)
  now(): Date               // returns a copy of current time
  setNow(d: Date): void     // set absolute time
  advance(ms: number): void // fast-forward by ms
}
```

**Test usage:**
```ts
const clock = new FakeClock(new Date('2025-01-01T00:00:00Z'));
const module = await Test.createTestingModule({ ... })
  .overrideProvider(CLOCK).useValue(clock)
  .compile();

// Advance past TTL (14 days = 1_209_600_000 ms)
clock.advance(15 * 24 * 60 * 60 * 1000);
await reaperService.sweep();
```

---

## 8. BalanceLockService API (`src/common/lock/balance-lock.service.ts`)

### Production API

```ts
class BalanceLockService {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>
}

function balanceKey(employeeId: string, locationId: string): string
// Returns: `${employeeId}::${locationId}`
```

`runExclusive` serializes callers on the same key; different keys run fully concurrently.
All five balance actors (approve, outbox dispatcher, reconciliation, reaper, retry worker)
MUST call `runExclusive(balanceKey(employeeId, locationId), ...)` before any mutation.

### Test Seam — `installLatch`

```ts
interface LatchHandle {
  reached: Promise<void>   // resolves when fn enters the critical section
  release(): void          // lets fn proceed past the latch
}

installLatch(key: string): LatchHandle
```

**How it works:**
1. Install the latch BEFORE starting the call you want to hold.
2. Start the first call (A). It enters `runExclusive`, signals `reached`, then blocks.
3. Assert a second call (B) on the same key is blocked (B's promise is not yet resolved).
4. Call `release()` to let A proceed.
5. Await both promises.

**Exact usage example (E2/E12/E21 concurrency tests):**
```ts
const key = balanceKey('emp1', 'loc1');
const latch = lockService.installLatch(key);

// Start A — will enter lock and pause
const promiseA = lockService.runExclusive(key, async () => {
  // body runs after latch is released
  return doWork();
});

// Wait until A is inside and holding the lock
await latch.reached;

// Fire B — it must queue behind A
let bStarted = false;
const promiseB = lockService.runExclusive(key, async () => {
  bStarted = true;
});

// B has not started yet
expect(bStarted).toBe(false);

// Release A
latch.release();
await promiseA;
await promiseB;

// B ran after A
expect(bStarted).toBe(true);
```

**Latches are one-shot.** Each `installLatch` call covers exactly the next `runExclusive`
call on that key. After use, the latch is removed automatically; subsequent calls run
without a latch.

---

## 9. HCM Contract Types (`src/hcm/contracts/hcm.types.ts`)

```ts
interface HcmBalance {
  employeeId: string; locationId: string; balance: number; asOf: string; // ISO-8601
}
interface FileTimeOffCommand {
  employeeId: string; locationId: string; days: number;
  startDate: string; endDate: string; idempotencyKey: string;
}
interface FileTimeOffResult {
  ok: boolean; ackedAt?: string; errorHint?: string;
}
interface ReverseTimeOffCommand {
  employeeId: string; locationId: string; days: number;
  startDate: string; endDate: string; idempotencyKey: string;
}
interface ReverseTimeOffResult {
  ok: boolean; ackedAt?: string; errorHint?: string;
}
interface BatchCorpus {
  sequence: number; asOf: string; balances: HcmBalance[];
}
```

### HcmClient interface (`src/hcm/contracts/hcm-client.interface.ts`)

```ts
interface HcmClient {
  getBalance(employeeId: string, locationId: string): Promise<HcmBalance>
  fileTimeOff(cmd: FileTimeOffCommand): Promise<FileTimeOffResult>
  reverseTimeOff(cmd: ReverseTimeOffCommand): Promise<ReverseTimeOffResult>
}
```

Token: `HCM_CLIENT`. Bound to `HcmClientService` by `HcmModule`.

---

## 10. Skeleton Service Methods

### HcmClientService (`src/hcm/hcm-client.service.ts`)

| Method         | Signature                                                             | Intended behavior + ADRs                                                                |
|----------------|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| getBalance     | `(employeeId, locationId) → Promise<HcmBalance>`                     | GET /hcm/balance. Called once per approve (ADR-001 step 1). Never throw on HCM error.  |
| fileTimeOff    | `(cmd: FileTimeOffCommand) → Promise<FileTimeOffResult>`             | POST /hcm/timeoff with Idempotency-Key header. At-least-once; idempotent (ADR-008).    |
| reverseTimeOff | `(cmd: ReverseTimeOffCommand) → Promise<ReverseTimeOffResult>`       | POST /hcm/timeoff/reverse. No-op at HCM if no FILE landed (ADR-004/ADR-008).           |

All methods: retry with exponential backoff up to `hcmRetryMaxAttempts` (ADR-004); return
`{ ok: false, errorHint }` rather than throwing; never log PHI (§12).

### OutboxDispatcherService (`src/hcm/outbox-dispatcher.service.ts`)

| Method          | Signature                             | Intended behavior + ADRs                                                                                             |
|-----------------|---------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| dispatchPending | `() → Promise<void>` @Interval(5000) | Poll PENDING outbox rows. For each: acquire balance-key lock, call HcmClient, mark SENT or FAILED (ADR-011/ADR-010). |
| dispatchOne     | `(outboxId: string) → Promise<void>`  | Dispatch a single row. Acquires the lock. Increments attempts. On FAILED >= maxAttempts: enqueue REVERSE → REJECTED (ADR-004). |

### BalanceService (`src/balance/balance.service.ts`)

| Method              | Signature                                                                      | Intended behavior + ADRs                                                                                                                                                                              |
|---------------------|--------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| getBalance          | `(employeeId, locationId) → Promise<Balance & { degraded?: boolean }>`         | Read-only. On first access for `(emp,loc)` (`lastHcmAsOf` null), acquires the balance-key lock and lazy-hydrates from HCM via `applyHcmSnapshot`. On `HcmUnavailableError`, returns an ephemeral `{ degraded: true }` DTO without persisting (next call retries). Gated by `BALANCE_LAZY_LOAD_ENABLED`. ADR-014. FR-1.  |
| validateAvailability| `(employeeId, locationId, days) → Promise<void>`                               | Throws ConflictException if `available - reserved < days`. Used for instant feedback at submit (ADR-001 local guard). No mutation.                                                                    |
| reserve             | `(employeeId, locationId, days, manager?: EntityManager) → Promise<void>`      | `reserved += days` only. `available` is NOT decremented here — only at commit. Double-check under lock: throws if `available - reserved < days`. ADR-002.                                            |
| release             | `(employeeId, locationId, days, manager?: EntityManager) → Promise<void>`      | `reserved -= days` (floored at 0). Called on REJECTED/EXPIRED/cancel of PENDING. Under lock.                                                                                                         |
| commit              | `(employeeId, locationId, days, manager?: EntityManager) → Promise<void>`      | `available -= days`, `reserved -= days`. Under lock. ADR-001 step 4.                                                                                                                                 |
| restore             | `(employeeId, locationId, days, manager?: EntityManager) → Promise<void>`      | `available += days`. Called on cancel/reject/expire of APPROVED or PENDING_SYNC. Under lock.                                                                                                         |
| applyHcmSnapshot    | `(snapshot: HcmBalance, manager?: EntityManager) → Promise<void>`              | Sets `available = snapshot.balance`, `lastHcmAsOf = snapshot.asOf`. Under lock. ADR-001 step 2.                                                                                                      |
| reconcileBalance    | `(hcmEntry: HcmBalance, asOf: Date, manager?: EntityManager) → Promise<void>`  | ADR-003: base = hcmValue, replay APPROVED/PENDING_SYNC with hcmAckAt IS NULL OR > asOf, outstanding PENDING reservations, pending REVERSEs. Creates ReconciliationEvent. Sets needsReview if negative (B4). Under lock. |
| resolveReview       | `(employeeId, locationId) → Promise<void>`                                     | Clears needsReview. Manager-only (enforced in controller). Acquires its own lock. ADR-003/B4.                                                                                                         |

#### Transaction participation (ADR-013)

When a caller holds an active `EntityManager` from a `dataSource.transaction(async manager => {...})` block,
it passes `manager` as the trailing argument to any mutator. The mutator then routes all balance reads and
writes through `manager.getRepository(Balance)` and `manager.save(Balance, ...)`, making the balance write
part of the caller's transaction.

When `manager` is omitted, the mutator uses the default injected `DataSource` (current behavior, unchanged).

This convention ensures that balance + request + outbox writes commit as one atomic unit, closing the crash
window described in ADR-011/NFR-7/E17. See ADR-013 for full rationale.

### TimeOffRequestService (`src/time-off-request/time-off-request.service.ts`)

| Method  | Signature                                                          | Intended behavior + ADRs                                                                                                                  |
|---------|--------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| submit  | `(employeeId, locationId, startDate, endDate, idempotencyKey) → Promise<TimeOffRequest>` | ADR-012: idempotency check → overlap check → availability check → create PENDING + reserve. All under lock. `days` server-computed. |
| approve | `(requestId, managerId) → Promise<TimeOffRequest>`                | ADR-001: GET HCM balance → applyHcmSnapshot → re-validate → check startDate not past (§10/E18) → commit → enqueue FILE → APPROVED or PENDING_SYNC. Under lock. |
| reject  | `(requestId, managerId, reason?) → Promise<TimeOffRequest>`       | release reservation; VOID pending FILE if PENDING_SYNC → REJECTED. Under lock. ADR-002.                                                  |
| cancel  | `(requestId, principalId) → Promise<TimeOffRequest>`              | PENDING: void FILE + release → CANCELLED. PENDING_SYNC/FILE_SENT: restore + enqueue REVERSE → CANCELLED. APPROVED: restore + enqueue REVERSE → CANCELLED. Under lock. ADR-004/ADR-008/ADR-011. |
| expire  | `(requestId) → Promise<TimeOffRequest>`                           | Release reservation + VOID pending FILE (same txn) → EXPIRED. DOES NOT acquire lock — caller (Reaper) holds it. ADR-002/B2.              |

**Key constraints for submit:**
- ADR-012 ①: active-state idempotency key check — if same key + same body → return existing. Same key + different body → 422.
- ADR-012 ②: overlap predicate: `newStart <= existingEnd AND newEnd >= existingStart` for any non-terminal request on same (employeeId, locationId).
- `days` = business days via location calendar (A6); server-computed (§12). Phase 1 must implement the calendar lookup or stub it.

### ReconciliationService (`src/reconciliation/reconciliation.service.ts`)

| Method            | Signature                                                              | Intended behavior + ADRs                                                                                |
|-------------------|------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| ingestBatch       | `(corpus: BatchCorpus) → Promise<void>`                               | ADR-009: reject if sequence <= last. For each balance: acquire lock, call reconcileBalance. Insert BatchSyncLog. |
| reconcileBalance  | `(employeeId, locationId, hcmValue, asOf) → Promise<void>`            | Delegates to balanceService.reconcileBalance under balance-key lock. ADR-003.                            |

### ReservationReaperService (`src/reservation-reaper/reservation-reaper.service.ts`)

| Method | Signature                           | Intended behavior + ADRs                                                                                                                           |
|--------|-------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| sweep  | `() → Promise<void>` @Cron(every 5 min) | Find all PENDING/PENDING_SYNC with expiresAt <= now(). For each: acquire balance-key lock, call timeOffRequestService.expire(id). ADR-002/B2/E15/E24. |

---

## 11. HTTP Routes Summary

| Method | Path                              | Controller              | Auth                   | ADRs        |
|--------|-----------------------------------|-------------------------|------------------------|-------------|
| GET    | /                                 | HealthController        | none                   | —           |
| GET    | /balances                         | BalanceController       | any principal          | FR-1, §12  |
| PATCH  | /balances/resolve-review          | BalanceController       | manager only           | ADR-003/B4  |
| POST   | /time-off-requests                | TimeOffRequestController| employee (own ID)      | FR-2, ADR-012 |
| POST   | /time-off-requests/:id/approve    | TimeOffRequestController| manager only           | FR-4, ADR-001 |
| POST   | /time-off-requests/:id/reject     | TimeOffRequestController| manager only           | FR-4, ADR-002 |
| POST   | /time-off-requests/:id/cancel     | TimeOffRequestController| principal (own/manager)| FR-6, ADR-004 |
| POST   | /timeoff/hcm/batch                | BatchController         | service token (future) | §8, ADR-009 |

**Auth headers (injected by upstream gateway, §12/A4):**
- `X-Employee-Id` — trusted employee ID of the authenticated caller
- `X-Role` — `'employee'` or `'manager'`

**Submit special header:**
- `Idempotency-Key` — client-minted UUID v4; required; 422 if absent (ADR-012)

---

## 12. Global Validation

`main.ts` registers `ValidationPipe({ whitelist: true, transform: true })`.
All controllers receive validated, transformed DTOs. Unknown fields are stripped silently.

---

## 13. TRD Ambiguities Resolved

| # | Ambiguity | Resolution |
|---|-----------|------------|
| 1 | ADR-012 says idempotency key uniqueness is "scoped to active states" but suggests a DB UNIQUE constraint | DB UNIQUE column exists; active-state scoping is enforced in service logic. A terminal request's key is reusable (L1/E28) by checking at submit time whether the existing request is in a terminal state. |
| 2 | TypeORM 1.0.0 referenced in package.json | Package is behaviorally identical to 0.3.x. Uses `DataSource`, `Repository`, `@VersionColumn`, `forRootAsync` — all standard 0.3.x API. Do NOT use the deprecated 0.2.x `createConnection` pattern. |
| 3 | `days` computation requires a location calendar (A6) | `days` field is always server-computed. Phase 1 must implement or stub the business-day calculator. The `days` field is on `TimeOffRequest` and `BalanceService` methods accept it as a parameter — the calendar lookup is scoped to `TimeOffRequestService.submit`. |
| 4 | `expire` is called by the Reaper which already holds the balance-key lock | `expire` does NOT re-acquire the lock. The Reaper acquires the lock, then calls `expire`. This is documented on the signature. This asymmetry avoids deadlock. |
| 5 | `BatchController` route is `/timeoff/hcm/batch` (from TRD §8) | Controller prefix is `/timeoff/hcm`, route is `POST batch` — full path `/timeoff/hcm/batch`. Matches §8 exactly. |
| 6 | `hcmAckAt` vs `committedAt` as replay cutoff | Per ADR-003 v3 fix: replay cutoff is `hcmAckAt`, NOT `committedAt`. A commit before asOf with hcmAckAt after asOf must be replayed. Both fields are on `TimeOffRequest`. |
| 7 | `applyHcmSnapshot` and `reconcileBalance` both set `lastHcmAsOf` | `applyHcmSnapshot` (realtime approve path) sets it immediately. `reconcileBalance` (batch path) sets it to the batch `asOf`. They are distinct calls and the lock prevents interleaving. |

---

## 14. What Phase 1 Must Implement

- `HcmClientService` bodies: HTTP calls via `@nestjs/axios`, retry/backoff, idempotency header.
- `OutboxDispatcherService.dispatchPending` + `dispatchOne` bodies.
- `BalanceService` all method bodies (balance math, optimistic lock retry on version conflict).
- `TimeOffRequestService` all method bodies (state machine, ADR-012 guards, overlap query).
- `ReconciliationService.ingestBatch` + `reconcileBalance` bodies (ADR-003/ADR-009).
- `ReservationReaperService.sweep` body (ADR-002/B2).
- Business-day calculator (A6 dependency) — either implement or stub returning `endDate - startDate + 1` as a calendar-day count until a real calendar is available.
- TypeORM schema migration strategy (`synchronize: false` in production means migrations are needed; Phase 1 can use `synchronize: true` behind a feature flag or add migration files).
