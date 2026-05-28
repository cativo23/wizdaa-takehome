# test/e2e-helpers

Utility helpers for the supertest e2e suite. See `docs/E2E-DESIGN.md` for architecture and rationale.

| File | Purpose |
|------|---------|
| `bootstrap-test-app.ts` | Boots the SUT (`AppModule` minus `ScheduleModule`) with in-memory SQLite and `ValidationPipe`. Pass `hcmBaseUrl` to wire to a real mock-hcm; omit it for `FakeHcmClient`. |
| `bootstrap-mock-hcm.ts` | Boots `MockHcmModule` on an ephemeral port. Returns `{ url, resetStore, setScenario, seedBalance, close }`. Boot this BEFORE the SUT (R1). |
| `with-latency-budget.ts` | `withLatencyBudget(label, maxMs, fn)` — asserts the async fn finishes within the budget. |
| `http-headers.ts` | `asEmployee(empId)` / `asManager(mgrId?)` — convenience header maps for `.set(...)` calls. |

## R6 choice: option (b) with HTTP isolation

The `bootstrapMockHcm` helper uses the mock HCM's own HTTP control API (`POST /_control/scenario`, `POST /_control/refresh`) rather than importing the module-level `balanceStore` Map directly. This avoids a module-singleton split that arises in Jest when the `.js`-extension import path used by `HcmController` (`'./mock-hcm.store.js'`) and the path used by test code (`'../../src/mock-hcm/mock-hcm.store'`) land in different cache slots.

All tests use `crypto.randomUUID()` employee IDs for extra balance-store isolation. The `resetMockHcmStore()` export added to `src/mock-hcm/mock-hcm.store.ts` is still present for potential future use but is not relied upon by the e2e helpers.
