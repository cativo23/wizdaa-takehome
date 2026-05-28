# E2E-DESIGN.md — Supertest HTTP-Integration Layer

**Status:** Frozen design
**Author:** designer (e2e-supertest team)
**Date:** 2026-05-27
**Audience:** `implementer` (Sonnet). Build exactly what is in §3. Architecture
in §1 is non-negotiable; layout in §2 names the files; §3 names every test.
Send a SendMessage to `designer` if anything below is genuinely ambiguous.

---

## 0. Why this layer exists (one paragraph; skip if you've read the brief)

We have 70+ Jest specs at `src/**/*.spec.ts` that override `HCM_CLIENT` with
`FakeHcmClient`. They are excellent at unit + component-integration scope but
they never go through the HTTP boundary, the global `ValidationPipe`, the
class-transformer serialization, the header parsing in the controllers, or the
real `HcmClientService` retry budget. The curl smoke at
`scripts/e2e-smoke.sh` does hit the boundary, but it requires a live Docker
stack, takes ~3 minutes, and is unfit for PR-gate use. The supertest layer
fills the gap: real HTTP, real pipes, real retries when needed, in-process and
fast enough to run on every PR. It catches the four bug classes the curl smoke
caught (cold-read 31s hang, approve hang under HCM-down, serialization shape
drift, header-parsing edges) and locks them down as regression tests.

---

## 1. Test architecture

### 1.1 The two app instances

You will boot **two** Nest apps inside each spec file that needs the
networked-HCM path:

**(a) System Under Test (SUT).** Bootstrapped from a *custom* test module
that mirrors `AppModule` except for **two intentional differences**:

1. Do **not** import `ScheduleModule.forRoot()`. With `@nestjs/schedule`'s
   root module absent, the `@Interval(5000)` on
   `OutboxDispatcherService.dispatchPending` and the `@Cron(...)` on
   `ReservationReaperService.sweep` are inert. Tests drive both manually via
   the existing helpers in `src/testing/concurrency-helpers.ts`
   (`runDispatcherOnce`, `runReaperOnce`). This is the same trick
   `createTestModule()` already uses for the unit suite — copy that approach.
   Manual dispatch is **far** more deterministic than `setTimeout` racing
   with `jest.useFakeTimers()` and avoids a category of leaked-handle flakes.
2. Use in-memory SQLite. Build `DataSourceOptions` exactly as the unit harness
   does:
   ```ts
   buildDataSourceOptions({ database: ':memory:', synchronize: true, dropSchema: true })
   ```
   The `synchronize: true` lets you skip migrations; `dropSchema: true` makes
   per-test isolation cheap.

After `Test.createTestingModule({...}).compile()`, **apply the same
`ValidationPipe` as `src/main.ts`** before `init()`:
```ts
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
```
Skipping this is the #1 way to write a green e2e test that lies about
production behavior — every validation-pipe test below depends on it being
identical.

For HTTP, use `app.getHttpServer()` directly — no `app.listen()` is needed.
`supertest(app.getHttpServer())` runs in-process, on an ephemeral port that
the test never sees. (Exception: see 1.2 for when you DO need to `listen`.)

**(b) Mock HCM app.** Bootstrapped from `MockHcmModule`
(`src/mock-hcm/mock-hcm.module.ts`) in a **second** `TestingModule`. Apply
the same `ValidationPipe` as `src/mock-hcm/main.ts` does. **You must call
`app.listen(0)`** on this one because the SUT's `HcmClientService` will reach
it over HTTP via `axios`; `getHttpServer()` is not enough.

After `listen(0)`, read the ephemeral port:
```ts
const addr = mockHcmApp.getHttpServer().address() as AddressInfo;
const hcmBaseUrl = `http://127.0.0.1:${addr.port}`;
```
Wire the SUT to this URL by **overriding `AppConfigService.hcmBaseUrl`** on
the SUT's `TestingModuleBuilder`. The cleanest way is to override
`AppConfigService` itself with a tiny stub so a single value can be read by
the rest of the service unchanged:

```ts
.overrideProvider(AppConfigService).useValue({
  ...realDefaults,                  // databasePath, ports, etc. — copy from class
  hcmBaseUrl,                       // ← the mock app's URL
  hcmRetryMaxAttempts: 5,
  hcmRetryBackoffMs: 1000,
  balanceLazyLoadEnabled: true,
})
```
Do this **before** the SUT compiles — `HcmClientService` reads
`config.hcmBaseUrl` on every call, so a late update would still propagate, but
boot-time override keeps the test obvious. See §6 for the boot-order risk.

### 1.2 When to use real-mock-hcm vs. `FakeHcmClient`

| You're testing | Use | Why |
|---|---|---|
| Lifecycle correctness, balance math, state machine | `FakeHcmClient` via `.overrideProvider(HCM_CLIENT).useValue(new FakeHcmClient())` | Zero I/O. Mirrors the unit harness exactly. |
| Validation-pipe behaviour, DTO shape, auth headers, IDOR | `FakeHcmClient` | The HCM client is irrelevant here. |
| Serialization shape of `Balance` / `TimeOffRequest` responses | `FakeHcmClient` | Faster, same JSON. |
| **Latency under HCM-down (the cold-read 31s bug)** | **Real `MockHcmModule`** + real `HcmClientService` | The retry budget only exists in the real client. The fake throws immediately. |
| Approve hang under HCM-down | Real mock HCM | Same reason. |
| Idempotency-key dedup at HCM | Real mock HCM | Verifies our `Idempotency-Key` header actually reaches HCM. |
| Batch ingest end-to-end including `emit-batch` push | Real mock HCM | Verifies our `BatchController` parses the corpus shape the real mock emits. |

Rule of thumb: if the test asserts a timing budget or a network behaviour
(retry, idempotency over the wire, batch push), boot the real mock HCM.
Otherwise use `FakeHcmClient`.

### 1.3 Database isolation: per-test, not per-file

Per-test (`beforeEach`: build app + `app.init()`; `afterEach`:
`app.close()`). Reasons:
- The whole SUT app is ~150 ms to boot (no Schedule, no HTTP `listen`). With
  ~40 tests this is ~6 s of overhead total — acceptable for an e2e suite.
- Per-file with `dropSchema` between tests works in TypeORM but quietly
  shares the lock service singleton across tests, which is a leak waiting
  to bite a test that latches without releasing.
- Specs that need the mock HCM (latency + integration) can amortise it: boot
  the mock once per file in `beforeAll`/`afterAll` (it's stateless apart
  from `balanceStore` + `idempotencyStore`, which you reset with
  `setScenario('correct')` + a fresh employee ID per test).

So: **SUT per-test, mock-HCM per-file** for the two specs that use it.

### 1.4 Supertest API: copy these patterns verbatim

```ts
import request from 'supertest';

// Standard headers — extract to a helper, you'll use this 30+ times
const asEmployee = (empId: string) => ({
  'X-Employee-Id': empId,
  'X-Role': 'employee',
});
const asManager = (mgrId = 'mgr1') => ({
  'X-Employee-Id': mgrId,
  'X-Role': 'manager',
});

// GET /balances
const balRes = await request(app.getHttpServer())
  .get('/balances')
  .query({ employeeId: 'emp1', locationId: 'loc1' })
  .set(asEmployee('emp1'))
  .expect(200);

// POST /time-off-requests (submit) — captures id for chaining
const submitRes = await request(app.getHttpServer())
  .post('/time-off-requests')
  .set(asEmployee('emp1'))
  .set('Idempotency-Key', 'idem-' + crypto.randomUUID())
  .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-06', endDate: '2026-07-07' })
  .expect(201);
const requestId: string = submitRes.body.id;

// POST /time-off-requests/:id/approve
await request(app.getHttpServer())
  .post(`/time-off-requests/${requestId}/approve`)
  .set(asManager())
  .send({})
  .expect(201);

// POST /time-off-requests/:id/reject
await request(app.getHttpServer())
  .post(`/time-off-requests/${requestId}/reject`)
  .set(asManager())
  .send({ reason: 'budget' })
  .expect(201);

// POST /time-off-requests/:id/cancel
await request(app.getHttpServer())
  .post(`/time-off-requests/${requestId}/cancel`)
  .set(asEmployee('emp1'))
  .expect(201);

// PATCH /balances/resolve-review
await request(app.getHttpServer())
  .patch('/balances/resolve-review')
  .set(asManager())
  .send({ employeeId: 'emp1', locationId: 'loc1' })
  .expect(200);

// POST /timeoff/hcm/batch
await request(app.getHttpServer())
  .post('/timeoff/hcm/batch')
  .send({
    sequence: 42,
    asOf: '2026-05-27T12:00:00.000Z',
    balances: [{ employeeId: 'emp1', locationId: 'loc1', balance: 20, asOf: '2026-05-27T12:00:00.000Z' }],
  })
  .expect(202);
```

Note the **status codes** above are what the controllers actually return —
NestJS defaults `@Post` to 201 (yes, even for approve/reject/cancel), and
`BatchController` explicitly sets `@HttpCode(202)`. Don't "fix" these.

### 1.5 Latency-budget helper

Put this in `test/e2e-helpers/withLatencyBudget.ts`:

```ts
export async function withLatencyBudget<T>(
  label: string,
  maxMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  if (elapsed > maxMs) {
    throw new Error(`${label}: took ${elapsed} ms, budget was ${maxMs} ms`);
  }
  return result;
}
```

Usage in a test:

```ts
const res = await withLatencyBudget('GET /balances cold + HCM=timeout', 2000, () =>
  request(app.getHttpServer())
    .get('/balances')
    .query({ employeeId: freshEmp, locationId: 'loc1' })
    .set(asEmployee(freshEmp))
    .expect(200),
);
expect(res.body.degraded).toBe(true);
```

Why a helper instead of inline `Date.now()`: lets the implementer add
percentile/jitter assertions later, and the label makes failure output
self-explanatory. Keep it dead simple.

---

## 2. File layout

All under `test/`. The existing `test/jest-e2e.json` and the placeholder
`test/app.e2e-spec.ts` give you the scaffold the Nest CLI ships; build on
those rather than starting elsewhere.

```
test/
├── jest-e2e.json                     -- EDIT: add moduleNameMapper, bump testTimeout
├── app.e2e-spec.ts                   -- DELETE (placeholder, replaced by health in lifecycle spec)
│
├── e2e-helpers/
│   ├── bootstrap-test-app.ts         -- NEW: factory returning { app, modRef, hcm, clock, latch }
│   ├── bootstrap-mock-hcm.ts         -- NEW: boots MockHcmModule on ephemeral port, returns { url, close, setScenario, refresh }
│   ├── with-latency-budget.ts        -- NEW: §1.5
│   └── http-headers.ts               -- NEW: asEmployee/asManager helpers (§1.4)
│
├── lifecycle.e2e-spec.ts             -- ~8 tests; FakeHcmClient; submit→approve→cancel happy paths + health
├── auth-idor.e2e-spec.ts             -- ~12 tests; FakeHcmClient; every header + IDOR edge
├── validation-pipe.e2e-spec.ts       -- ~8 tests; FakeHcmClient; class-validator + whitelist behaviour
├── serialization.e2e-spec.ts         -- ~6 tests; FakeHcmClient; asserts response JSON shapes
├── batch-ingest.e2e-spec.ts          -- ~4 tests; FakeHcmClient; ingest + stale-rejection + no-drift
└── hcm-network.e2e-spec.ts           -- ~6 tests; real MockHcmModule; latency budgets + real-HCM round-trip
```

Total: ~44 tests across 6 spec files. Spec count is deliberately modest —
this layer is the *catch-net for HTTP-boundary regressions*, not a
reimplementation of the E1–E28 matrix (which the unit suite owns at §9.2 of
the TRD).

### 2.1 `test/jest-e2e.json` patches

The existing file omits two things you'll need:

```jsonc
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  // ADD these two:
  "moduleNameMapper": {
    "^(\\.{1,2}/.*)\\.js$": "$1"            // match the unit jest config — supports nodenext .js imports
  },
  "testTimeout": 15000                       // safety net for hcm-network spec only; per-test asserts catch slowness
}
```

Don't raise `testTimeout` higher — defeats the latency-bug-catching purpose.

---

## 3. Test catalog

Each row: `it` name; ASSERTS; LAYER (one of: lifecycle, auth, validation,
serialization, latency, integration, batch); LOCKS DOWN (curl-smoke S# the
test would have caught, or "N/A — pure regression").

### 3.1 `lifecycle.e2e-spec.ts` (FakeHcmClient)

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `GET / returns { status: 'ok' }` | 200, body shape | lifecycle | S1 |
| `submit returns 201 + PENDING + days computed server-side` | status, body.status, body.days > 0, body.id is uuid | lifecycle + serialization | S5 |
| `submit → approve → manual dispatcher tick → APPROVED` | After `runDispatcherOnce`, GET /balances shows `reserved: 0`, `available` decreased by `days` | lifecycle + integration | S5 |
| `approve → cancel approved → REVERSE dispatched → balance restored` | Cancel returns CANCELLED; after dispatcher tick, available back to original; `hcm.callsTo.reverseTimeOff === 1` | lifecycle | S10 |
| `submit → reject → REJECTED + reservation released` | available unchanged from pre-submit, reserved=0 | lifecycle | N/A |
| `submit insufficient balance → 409 + no reservation` | 409 status, GET shows reserved=0, available unchanged | lifecycle | S6 |
| `duplicate submit with same key + same body returns same id` | First and second responses both 201, identical `id`, reserved counted once | lifecycle | S7 / E8 |
| `same key, different body → 422` | Second submit 422; first request unchanged in DB | lifecycle | S8 / E23 |

### 3.2 `auth-idor.e2e-spec.ts` (FakeHcmClient)

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `GET /balances missing X-Employee-Id → 400` | 400, error message contains "X-Employee-Id" | auth | S2 |
| `GET /balances missing X-Role → 400` | 400 | auth | S2 |
| `GET /balances X-Role=bogus → 400` | 400, message names valid values | auth | S2 |
| `Employee A querying B's balance → 403` | 403, no DB read of B's row | auth | S2 |
| `Manager querying any employee's balance → 200` | 200 | auth | S2 |
| `POST submit missing Idempotency-Key → 400` | 400, message names header | auth | S2 |
| `POST submit for different employeeId than X-Employee-Id → 403` | 403 | auth | S2 |
| `Employee approving → 403` | 403 | auth | S2 |
| `Employee rejecting → 403` | 403 | auth | N/A |
| `Employee calling PATCH /balances/resolve-review → 403` | 403 | auth | S13 |
| `Manager calling PATCH /balances/resolve-review → 200 { ok: true }` | 200, body.ok=true | auth | S13 |
| `Cancel: employee can cancel own request; service enforces ownership` | 201 for own; controller defers ownership to service (TRD §12) — assert behaviour matches | auth | N/A |

### 3.3 `validation-pipe.e2e-spec.ts` (FakeHcmClient)

These specifically depend on the `ValidationPipe({whitelist:true,transform:true})`
being applied. Skip these if you forgot to apply the pipe — they're the
canary.

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `submit with malformed startDate → 400` | 400, class-validator message | validation | S15 |
| `submit with endDate < startDate → 400` | 400 | validation | S15 |
| `submit missing employeeId → 400` | 400 | validation | N/A |
| `submit with extra field `days: 999` is silently stripped, server recomputes` | 201; response.body.days matches business-day count of date range, NOT 999 | validation + security (§12) | N/A (critical regression: silent-strip means a stale test could miss this) |
| `submit with extra field `idempotencyKey: 'sneaky'` in body is stripped` | 201; idempotency uses header only | validation | N/A |
| `approve with non-UUID id → 400 (ParseUUIDPipe)` | 400 | validation | S15 |
| `batch with sequence: 'not-a-number' → 400/422` | non-2xx (400 acceptable) | validation | S15 |
| `batch with missing balances array → 400` | 400 | validation | N/A |

### 3.4 `serialization.e2e-spec.ts` (FakeHcmClient)

These lock down the response-JSON contract. They guard against an entity-column
rename or class-transformer regression silently changing the wire shape.

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `GET /balances shape includes all documented fields` | `toMatchObject({ employeeId, locationId, available: expect.any(Number), reserved: expect.any(Number), needsReview: expect.any(Boolean), lastHcmAsOf: ... })` plus no leaked internals (e.g. no TypeORM `__entity__`) | serialization | S3 / S13 |
| `GET /balances on cold tuple with FakeHcmClient(correct) hydrates available` | available === seeded HCM value, lastHcmAsOf is ISO string | serialization | S3 |
| `GET /balances on cold tuple with FakeHcmClient(timeout) returns { degraded: true, available: 0, lastHcmAsOf: null }` | Exact shape match | serialization + latency (no budget here, see hcm-network spec for real budget) | S4 |
| `POST submit response shape` | `{ id: uuid, employeeId, locationId, startDate, endDate, days, status: 'PENDING', idempotencyKey, hcmIdempotencyKey, expiresAt, createdAt }` — all present, correctly typed | serialization | S5 |
| `POST approve response shape includes committedAt OR null until dispatcher runs` | committedAt present (null before, ISO after manual dispatcher tick) | serialization | S5 |
| `POST batch returns { accepted: true } with 202` | status + body | serialization | S12 |

### 3.5 `batch-ingest.e2e-spec.ts` (FakeHcmClient)

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `POST /timeoff/hcm/batch with valid corpus → 202, balance updated` | available reflects HCM base; GET shows new value | batch + integration | S12 |
| `Stale batch (sequence ≤ last) is accepted but no state change` | First batch (seq=10) applies; second (seq=5) returns 202; subsequent GET shows balance unchanged from after-first | batch | S12 (the real bug it catches if drift returns) |
| `Out-of-order: seq=10 then seq=15 then seq=12 — last one is no-op` | available after seq=12 equals available after seq=15 | batch | N/A |
| `Batch with negative-driving math sets needsReview` | Seed local approved-but-unacked request; batch with lower HCM value; GET shows `needsReview: true` | batch + serialization | S13 |

For the `needsReview` test specifically: this is the response-shape angle on
S13. The curl smoke buried `needsReview` checks inside conditional logic
because timing made it nondeterministic; in-process you control the clock
and `hcmAckAt` directly via the existing `seedRequest` factory, so the
assertion is hard.

### 3.6 `hcm-network.e2e-spec.ts` (real MockHcmModule + real HcmClientService)

This is the spec that exists *to catch the latency bugs*. Boot the mock HCM
once per file; reset its scenario before each test. **Latency budgets are
the headline assertions.**

> Important: this spec assumes the in-flight `hcm-fastfail` fix has landed so
> the cold-read budget can be met. Until it does, mark these `.skip` with a
> TODO referencing the fix. The whole point of the design is that *once*
> the fix lands these tests prove it stays fixed.

| `it` | Asserts | Layer | Locks down |
|---|---|---|---|
| `Real-HCM happy path: submit → approve → dispatchPending → APPROVED + HCM store decremented` | Locally APPROVED after manual dispatcher; `GET ${hcmUrl}/hcm/balance` via supertest shows decremented value | integration | S5 |
| `Cold GET /balances with HCM=timeout returns degraded:true in < 2000 ms` | Wrap in `withLatencyBudget('cold-read', 2000, ...)`; body matches `{ available: 0, degraded: true, lastHcmAsOf: null }`. **THIS IS THE 31s BUG REGRESSION TEST.** | latency + serialization | S4 / S16 (the cold-read deadlock manifested as the same hang) |
| `Warm GET /balances with HCM=timeout returns cached value in < 100 ms, degraded NOT set` | After a warm read seeds `lastHcmAsOf`, scenario flips to timeout; budget 100 ms; body.degraded undefined-or-false | latency | S3 |
| `Approve with HCM=timeout (warm balance) → PENDING_SYNC in < 2000 ms` | Pre-warm, submit, flip scenario, approve. Budget 2000 ms; body.status === 'PENDING_SYNC'. **REGRESSION TEST FOR S11.** | latency | S11 |
| `Idempotency-Key is honored end-to-end at the HCM mock` | Submit → approve → call `dispatchPending` twice → `hcm.callsTo.fileTimeOff` increments twice on the mock, but the mock's `idempotencyStore` dedups; HCM balance decremented exactly once | integration | E11 / E16 (not in curl smoke as a pure assertion) |
| `Batch emit via mock HCM control endpoint reaches our BatchController` | `POST ${hcmUrl}/_control/emit-batch { targetUrl: \`http://127.0.0.1:${sutPort}/timeoff/hcm/batch\` }` → 200; SUT balance updated. NOTE: requires SUT `app.listen(0)` for this test only — see §6. | integration | S12 |

---

## 4. Per-failure mapping from the curl smoke

The brief asked for explicit coverage of S3, S4, S5, S11, S12, S13, S16. Here
is the catch-or-doesn't-catch matrix.

| Smoke # | What the smoke caught (or risk) | Caught by supertest? | Which test | Assertion shape |
|---|---|---|---|---|
| **S3** — Cold-read lazy-hydration, warm-cache-degraded-not-set | YES | serialization.e2e-spec.ts: warm-cache test; hcm-network: warm GET budget | Body `toMatchObject({ available: 11, degraded: undefined })`, plus elapsed < 100 ms |
| **S4** — Cold + HCM=timeout returns ephemeral degraded; **31 s hang regression** | YES | hcm-network.e2e-spec.ts: cold + timeout in < 2000 ms | `withLatencyBudget('cold-read', 2000, ...)` + body `{ available: 0, degraded: true, lastHcmAsOf: null }` |
| **S5** — Happy path submit→approve→APPROVED | YES | lifecycle.e2e-spec.ts (Fake) + hcm-network (real) | Status transitions + balance arithmetic + manual `runDispatcherOnce` |
| **S11** — Approve with HCM=timeout → PENDING_SYNC in bounded time + retry-cap → REJECTED | PARTIAL. Latency on approve: YES (hcm-network). Retry-cap → REJECTED: NO — the cap path takes ~30 s in real time even with a fast-fail GET, because the FILE-side retry budget is intentionally full. **Keep this in the unit suite (already covered).** | hcm-network: approve latency only | `withLatencyBudget('approve PENDING_SYNC', 2000, ...)` + body.status === 'PENDING_SYNC' |
| **S12** — Batch ingest applies; stale batch does not drift state | YES | batch-ingest.e2e-spec.ts | Compare GET /balances before/after stale POST; assert equal |
| **S13** — Reconcile drives negative → needsReview=true; resolve-review clears it | YES (deterministic via seeded `hcmAckAt`) | batch-ingest.e2e-spec.ts: needsReview test; auth-idor.e2e-spec.ts: resolve-review auth | `body.needsReview === true` then `body.needsReview === false` after PATCH |
| **S16** — Cold-cache submit deadlock (lock re-entrancy) | YES, same shape as S4 | hcm-network.e2e-spec.ts: cold-read latency test exercises the same code path. Optionally add a `POST submit` cold-cache test with `withLatencyBudget('cold-submit', 2000, ...)` to specifically target the submit deadlock path | Budget assertion fails if the deadlock returns |

### 4.1 What the supertest layer does NOT catch (keep the curl smoke for these)

- **Docker port conflicts**, **container healthcheck wiring**,
  `compose.yml` env vars, the production `Dockerfile`'s `node dist/main`
  command path, the `wget -qO-` healthcheck behaviour.
- **`X-Powered-By: Express` header leak** (S1 finding) — `app.disable('x-powered-by')`
  belongs in `src/main.ts` and would be missing from the in-process
  bootstrap unless we wire it deliberately. Recommend the implementer
  **also** disables it in `bootstrap-test-app.ts` once it's fixed in
  production, so the smoke and the e2e suite agree.
- **Real Docker network between SUT and mock-hcm** (the `http://app:3000` and
  `http://mock-hcm:3001` DNS lookups). Out of scope.
- **`@Interval(5000)` dispatcher actually firing on schedule.** The unit
  suite covers `dispatchPending` directly; the e2e suite drives it manually.
  Verifying the schedule decorator itself is a one-time concern best left to
  the curl smoke or a Docker-level test.

The curl smoke stays in CI as the *deployment* smoke, run against a built
Docker stack, ideally post-build pre-deploy. It is **not** a PR gate.

---

## 5. CI integration

### 5.1 npm script (already exists)

```
"test:e2e": "jest --config ./test/jest-e2e.json"
```

No change needed; just apply the `jest-e2e.json` patches in §2.1.

### 5.2 PR gate vs deployment gate

| Suite | Command | When | Target time |
|---|---|---|---|
| Unit + component-integration | `npm test` | every PR | already < 20 s |
| **E2E supertest (new)** | `npm run test:e2e` | every PR | **< 30 s** |
| Curl smoke | `bash scripts/e2e-smoke.sh` against Docker | post-build, pre-deploy | ~3 min |

### 5.3 Estimated e2e wall-clock

- `lifecycle.e2e-spec.ts` — 8 tests × ~150 ms boot + ~50 ms test = ~1.6 s
- `auth-idor.e2e-spec.ts` — 12 tests × ~150 ms = ~2 s (cheap; no DB ops on most)
- `validation-pipe.e2e-spec.ts` — 8 tests × ~150 ms = ~1.3 s
- `serialization.e2e-spec.ts` — 6 tests × ~150 ms = ~1 s
- `batch-ingest.e2e-spec.ts` — 4 tests × ~200 ms (more DB writes) = ~0.8 s
- `hcm-network.e2e-spec.ts` — 6 tests × (~200 ms test + 1 mock boot shared) + ~300 ms mock boot = ~1.5 s

Total: **~8 s** of test work plus jest startup (~3 s) ≈ **~11 s wall-clock**.
Budget is 30 s for headroom; if it regresses, the latency tests will catch
the cause before the wall-clock does.

---

## 6. Risks for the implementer (READ THIS BEFORE CODING)

### R1. Boot order with mock-HCM URL override

The mock HCM must be listening on its ephemeral port **before** the SUT's
`AppConfigService.hcmBaseUrl` is read by anything. Two safe orderings:

**Safe (recommended):**
```ts
beforeAll(async () => {
  mockHcm = await bootstrapMockHcm();        // app.listen(0); returns { url, ... }
  sutApp = await bootstrapTestApp({          // overrides AppConfigService with mockHcm.url
    hcmBaseUrl: mockHcm.url,
  });
});
```

**Unsafe:** Building the SUT first, then trying to mutate the
`AppConfigService` value, then calling `init()`. `HttpService` reads
`hcmBaseUrl` on every call (not at boot), so it would *technically* work,
but you'd be relying on a property of the implementation that could change.
Don't.

### R2. Cleanup — `afterAll` must close BOTH apps

```ts
afterAll(async () => {
  await sutApp?.close();
  await mockHcm?.close();
});
```

Forgetting `mockHcm.close()` leaks the listening port; jest will warn `A
worker process has failed to exit gracefully`. If you see that warning,
that's the bug.

### R3. ScheduleModule is intentionally absent from the SUT bootstrap

Confirm by grep that `ScheduleModule.forRoot()` is **not** in your
`bootstrap-test-app.ts` imports. If it is, the `@Interval(5000)` dispatcher
will start firing on `init()`, and your test assertions about call counts
(`hcm.callsTo.fileTimeOff === 1`) will race. Drive the dispatcher manually
with `runDispatcherOnce(modRef.get(OutboxDispatcherService))` instead.

### R4. `ValidationPipe` must be applied to the SUT app

`Test.createTestingModule({...}).compile()` followed by
`moduleRef.createNestApplication()` does **not** apply the global pipes from
`main.ts`. You must call `app.useGlobalPipes(new ValidationPipe({...}))`
yourself. Forget this and the validation-pipe spec lies (silently passes
because nothing validates), and the "extra-field stripped" assertion in the
serialization spec is meaningless.

### R5. `AppConfigService` override shape

`AppConfigService` is a class with getters, not an object literal. The
shortest override is `useValue` with a stub that has *plain properties* —
TypeScript's structural typing will accept it because the consumers read
`.hcmBaseUrl` etc. as values, not via `get`. Example in §1.1. The
alternative is `useFactory` returning a real `AppConfigService` wrapped
around a stubbed `ConfigService`, which is also fine but more code.

### R6. The mock HCM `balanceStore` and `idempotencyStore` are module-level singletons

Look at `src/mock-hcm/mock-hcm.store.ts` — the `Map`s are module-level. That
means even if you boot a fresh `TestingModule` per file, the mock HCM's
state persists across files within the same Jest worker. **Reset in
`beforeEach`:**

```ts
beforeEach(() => {
  // Reset mock HCM state — use unique employee IDs per test to be safe
  // (the simplest defense). Also reset scenario to 'correct'.
  fetch(`${mockHcm.url}/_control/scenario`, { method: 'POST', ... });
});
```

The simplest defense is unique employee IDs per test (the curl smoke
already does this with `RUN_ID`). Use `crypto.randomUUID()` for employee IDs
and skip the reset dance entirely.

### R7. `hcm-network.e2e-spec.ts` needs `app.listen(0)` for the batch-emit test only

The `_control/emit-batch` endpoint in the mock HCM HTTP-POSTs to a
`targetUrl` you supply. For that one test, the SUT must be listening on a
real port so the mock can reach it. Two options:

- Use `app.listen(0)` for the entire spec (simplest; ~5 ms extra per test).
- Call `app.listen(0)` only inside that one `it` and `app.close()` it at
  the end.

Option 1 is fine — measurable overhead is negligible. The other tests in
the file don't care whether `getHttpServer()` is also bound to a port; they
work either way.

### R8. `crypto.randomUUID()` and node 18

You're on Node 24 (`@types/node: ^24.0.0` in package.json). `crypto.randomUUID()`
is fine. Just `import { randomUUID } from 'node:crypto'`.

### R9. Don't replicate the unit suite

If you find yourself writing 30 tests in `lifecycle.e2e-spec.ts`, stop.
Lifecycle correctness is the unit suite's job; the e2e layer's job is
*HTTP-boundary regression coverage*. The catalog above is intentionally
small. Resist the urge.

---

## 7. Out-of-scope

- WebSocket/SSE — there's none.
- Auth gateway simulation — the tests use the trusted headers directly,
  matching `§12/A4` of the TRD.
- Performance load tests — covered by the latency budget on the critical
  paths; full load is a separate concern.
- Coverage instrumentation — `npm run test:cov` (Jest unit suite) is the
  coverage gate; the e2e suite is a behaviour gate. Don't add `--coverage`
  to `test:e2e`.

---

## 8. Open questions (resolve via SendMessage if blocking)

None at design time. If something below blocks implementation, ping
`designer`:

- If the `hcm-fastfail` PR hasn't merged when you write
  `hcm-network.e2e-spec.ts`, the cold-read latency test will fail. Mark it
  `.skip` with a `TODO(hcm-fastfail)` comment; don't lower the budget to
  hide it.
- If `AppConfigService` gains additional required properties before you
  finish, copy them into the stub override and we'll add them to a shared
  test default later.
