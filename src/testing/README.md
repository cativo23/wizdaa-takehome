# Test Harness — `src/testing/`

One-page reference for the four parallel test-writing agents.

---

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel — import everything from `'../testing'` |
| `test-module.ts` | `createTestModule(overrides?)` — NestJS testing module factory |
| `fake-hcm-client.ts` | `FakeHcmClient` — programmable in-process HCM double |
| `factories.ts` | `seedBalance`, `seedRequest`, `seedOutbox`, `seedBatchSyncLog`, `seedReconciliationEvent` |
| `concurrency-helpers.ts` | `withLockLatch`, `runDispatcherOnce`, `runReaperOnce` |

---

## `createTestModule(overrides?)`

Returns `{ builder, clock, hcm }` — NOT a compiled module yet.

```ts
const { builder, clock, hcm } = createTestModule();
const moduleRef = await builder.compile();
await moduleRef.init();
// ... test ...
await moduleRef.close();
```

- `builder` — `TestingModuleBuilder`; call `.compile()` then `.init()`.
- `clock` — `FakeClock` bound to `CLOCK`. Advance time freely.
- `hcm` — `FakeHcmClient` bound to `HCM_CLIENT`. Seed balances + set scenario.

**What's included:** In-memory SQLite (`synchronize: true, dropSchema: true`),
all domain modules (Balance, TimeOffRequest, HcmModule, Reconciliation,
ReservationReaper), AppConfigModule, ClockModule, LockModule.

**What's NOT included:** `ScheduleModule.forRoot()` — so `@Cron`/`@Interval`
hooks on the dispatcher and reaper stay dormant. Drive them manually (see below).

---

## Advancing time (`FakeClock`)

```ts
clock.advance(15 * 24 * 60 * 60 * 1000);  // jump 15 days (past 14-day TTL)
clock.setNow(new Date('2026-07-01T00:00:00Z'));  // set absolute time
```

---

## Driving the dispatcher and reaper manually

```ts
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { ReservationReaperService } from '../reservation-reaper/reservation-reaper.service';
import { runDispatcherOnce, runReaperOnce } from '../testing';

const dispatcher = moduleRef.get(OutboxDispatcherService);
await runDispatcherOnce(dispatcher);   // one full PENDING-row sweep

const reaper = moduleRef.get(ReservationReaperService);
clock.advance(15 * 24 * 60 * 60 * 1000);
await runReaperOnce(reaper);           // one full expiry sweep
```

---

## Deterministic concurrency (`withLockLatch`)

```ts
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { withLockLatch } from '../testing';

const lockService = moduleRef.get(BalanceLockService);

// 1. Install the latch BEFORE starting call A
const latch = withLockLatch(lockService, 'emp1', 'loc1');

// 2. Start A — it enters the lock and pauses
const promiseA = lockService.runExclusive(balanceKey('emp1', 'loc1'), async () => {
  // runs AFTER latch.release()
  return doWork();
});

// 3. Wait until A is inside the critical section
await latch.reached;

// 4. Fire B — it must queue behind A
let bStarted = false;
const promiseB = lockService.runExclusive(balanceKey('emp1', 'loc1'), async () => {
  bStarted = true;
});
expect(bStarted).toBe(false);  // B is blocked

// 5. Release A
latch.release();
await promiseA;
await promiseB;
expect(bStarted).toBe(true);
```

Latches are one-shot — install a fresh latch per assertion.

---

## `FakeHcmClient` scenario reference

| Scenario | getBalance | fileTimeOff | reverseTimeOff |
|---|---|---|---|
| `correct` | stored balance | deduct + ack | credit + ack |
| `silent-insufficient` | stored balance | ok=true, no deduct (E3) | credit + ack |
| `timeout` | throws `HcmUnavailableError` | `{ ok: false, errorHint: 'unreachable' }` | same |
| `mutate-between-calls` | decrements by 1 each call (E10) | deduct + ack | credit + ack |
| `divergent-batch` | stored balance | deduct + ack | credit + ack |
| `duplicate-delivery` | stored balance | idempotency dedup applies | idempotency dedup applies |
| `ignore-idempotency-key` | stored balance | applies every call (ADR-008 probe) | applies every call |

Set via `hcm.setScenario('timeout')`. Reset all state via `hcm.reset()`.

Call counters: `hcm.callsTo.getBalance`, `hcm.callsTo.fileTimeOff`, `hcm.callsTo.reverseTimeOff`.

---

## Typical test skeleton

```ts
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createTestModule, seedBalance, seedRequest, runDispatcherOnce } from '../testing';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { RequestStatus } from '../entities/enums';

describe('E4 — HCM timeout at approve → PENDING_SYNC', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  const { builder, clock, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    await seedBalance(balanceRepo, { available: 10 });
    hcm.seedBalance('emp1', 'loc1', 10);
    hcm.setScenario('timeout');
  });

  afterEach(() => moduleRef.close());

  it('transitions to PENDING_SYNC when HCM is unreachable', async () => {
    // submit first
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'idem-1');
    // approve — HCM is down → PENDING_SYNC
    const result = await svc.approve(req.id, 'manager1');
    expect(result.status).toBe(RequestStatus.PENDING_SYNC);
  });
});
```
