/**
 * ADR-014 — Cold-read lazy hydration from HCM.
 *
 * Five scenarios testing the new getBalance behaviour:
 *   a. Cold hit hydrates and persists.
 *   b. Warm hit skips HCM entirely.
 *   c. HCM unavailable → ephemeral degraded DTO; nothing persisted; self-heals.
 *   d. Stampede (double-checked locking): only one HCM call despite concurrent cold readers.
 *   e. Flag disabled → legacy zero-on-miss behavior; no HCM call.
 *   f. (regression S16) submit on cold cache does not deadlock.
 */

import { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  createTestModule,
  withLockLatch,
} from '../testing';
import { Balance } from '../entities/balance.entity';
import { BalanceService } from '../balance/balance.service';
import { BalanceLockService, balanceKey } from '../common/lock/balance-lock.service';
import { AppConfigService } from '../config/app-config.service';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { RequestStatus } from '../entities/enums';

// ---------------------------------------------------------------------------
// Helper: load a balance row from the repo (null = not persisted)
// ---------------------------------------------------------------------------
async function getRow(
  repo: Repository<Balance>,
  emp: string,
  loc: string,
): Promise<Balance | null> {
  return repo.findOne({ where: { employeeId: emp, locationId: loc } });
}

// ---------------------------------------------------------------------------
// describe block
// ---------------------------------------------------------------------------

describe('ADR-014 — cold-read lazy hydration', () => {
  // ---------------------------------------------------------------------------
  // (a) Cold hit hydrates and persists.
  // ---------------------------------------------------------------------------
  describe('(a) cold hit hydrates and persists', () => {
    const { builder, hcm } = createTestModule();
    let moduleRef: TestingModule;
    let balanceSvc: BalanceService;
    let balanceRepo: Repository<Balance>;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      balanceSvc = moduleRef.get(BalanceService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('getBalance on a cold tuple calls HCM once and persists the hydrated row', async () => {
      hcm.seedBalance('emp1', 'loc1', 17);

      // No row in DB yet
      expect(await getRow(balanceRepo, 'emp1', 'loc1')).toBeNull();

      const result = await balanceSvc.getBalance('emp1', 'loc1');

      // Correct value returned
      expect(result.available).toBe(17);
      expect(result.lastHcmAsOf).not.toBeNull();
      expect(hcm.callsTo.getBalance).toBe(1);

      // Row persisted in DB
      const persisted = await getRow(balanceRepo, 'emp1', 'loc1');
      expect(persisted).not.toBeNull();
      expect(persisted!.available).toBe(17);
      expect(persisted!.lastHcmAsOf).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // (b) Warm hit skips HCM.
  // ---------------------------------------------------------------------------
  describe('(b) warm hit skips HCM', () => {
    const { builder, hcm } = createTestModule();
    let moduleRef: TestingModule;
    let balanceSvc: BalanceService;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      balanceSvc = moduleRef.get(BalanceService);
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('second getBalance call does not increment HCM call counter', async () => {
      hcm.seedBalance('emp1', 'loc1', 10);

      // First call (cold) — hydrates from HCM
      await balanceSvc.getBalance('emp1', 'loc1');
      expect(hcm.callsTo.getBalance).toBe(1);

      // Capture and reset counter to isolate the second call
      hcm.callsTo.getBalance = 0;

      // Second call (warm — lastHcmAsOf is now set)
      const second = await balanceSvc.getBalance('emp1', 'loc1');
      expect(hcm.callsTo.getBalance).toBe(0); // HCM not called
      expect(second.available).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) HCM unavailable → degraded ephemeral; nothing persisted; self-heals.
  // ---------------------------------------------------------------------------
  describe('(c) HCM unavailable — degraded ephemeral, no persist, self-heals', () => {
    const { builder, hcm } = createTestModule();
    let moduleRef: TestingModule;
    let balanceSvc: BalanceService;
    let balanceRepo: Repository<Balance>;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      balanceSvc = moduleRef.get(BalanceService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('returns ephemeral degraded DTO, persists nothing, then self-heals when HCM recovers', async () => {
      // ① HCM is down
      hcm.setScenario('timeout');

      const degraded = await balanceSvc.getBalance('emp1', 'loc1');

      // Degraded DTO returned with correct flags
      expect((degraded as any).degraded).toBe(true);
      expect(degraded.available).toBe(0);
      expect(degraded.lastHcmAsOf).toBeNull();

      // CRUCIAL: nothing was persisted — next request retries cold-load
      const inDb = await getRow(balanceRepo, 'emp1', 'loc1');
      expect(inDb).toBeNull();

      // ② HCM recovers — next call should hydrate successfully
      hcm.setScenario('correct');
      hcm.seedBalance('emp1', 'loc1', 42);

      const recovered = await balanceSvc.getBalance('emp1', 'loc1');
      expect((recovered as any).degraded).toBeUndefined();
      expect(recovered.available).toBe(42);
      expect(recovered.lastHcmAsOf).not.toBeNull();

      // Row now persisted
      const afterRecovery = await getRow(balanceRepo, 'emp1', 'loc1');
      expect(afterRecovery).not.toBeNull();
      expect(afterRecovery!.available).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // (d) Stampede — double-checked locking: only one HCM call for concurrent
  //     cold readers on the same key.
  // ---------------------------------------------------------------------------
  describe('(d) stampede / double-checked locking', () => {
    const { builder, hcm } = createTestModule();
    let moduleRef: TestingModule;
    let balanceSvc: BalanceService;
    let lockService: BalanceLockService;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      balanceSvc = moduleRef.get(BalanceService);
      lockService = moduleRef.get(BalanceLockService);
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('concurrent cold readers result in exactly one HCM call; B short-circuits on re-check', async () => {
      hcm.seedBalance('emp1', 'loc1', 12);

      // Install a latch so call A holds the lock until we release it.
      const latch = withLockLatch(lockService, 'emp1', 'loc1');

      // Fire call A — it will enter the lock and pause at the latch.
      // getBalance internally calls lockService.runExclusive, which will hit the latch.
      const promiseA = balanceSvc.getBalance('emp1', 'loc1');

      // Wait until A is inside the critical section
      await latch.reached;

      // Fire call B — it must queue behind A (lock held by A)
      let bResolved = false;
      const promiseB = balanceSvc.getBalance('emp1', 'loc1').then((r) => {
        bResolved = true;
        return r;
      });

      // Give the event loop a tick — B should NOT have completed yet
      await new Promise((r) => setImmediate(r));
      expect(bResolved).toBe(false);

      // Release A — it will complete the HCM call and persist
      latch.release();

      const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

      // Both calls returned the correct value
      expect(resultA.available).toBe(12);
      expect(resultB.available).toBe(12);

      // Only one HCM call — B short-circuited after seeing a warm row on re-check
      expect(hcm.callsTo.getBalance).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // (e) Flag disabled → legacy zero-on-miss behavior; no HCM call.
  // ---------------------------------------------------------------------------
  describe('(e) BALANCE_LAZY_LOAD_ENABLED=false → legacy behavior', () => {
    // Override AppConfigService to return balanceLazyLoadEnabled: false
    const stubbedConfig = {
      balanceLazyLoadEnabled: false,
      // Provide other used getters with safe defaults
      reservationTtlDays: 14,
      hcmRetryMaxAttempts: 5,
      hcmRetryBackoffMs: 1000,
      port: 3000,
      databasePath: ':memory:',
      hcmBaseUrl: 'http://localhost:3001',
    };

    const { builder, hcm } = createTestModule([
      { token: AppConfigService, useValue: stubbedConfig },
    ]);
    let moduleRef: TestingModule;
    let balanceSvc: BalanceService;
    let balanceRepo: Repository<Balance>;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      balanceSvc = moduleRef.get(BalanceService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('returns legacy persisted zero row; makes no HCM call', async () => {
      // No HCM seed — should not be called at all
      const result = await balanceSvc.getBalance('emp1', 'loc1');

      expect(result.available).toBe(0);
      expect(result.reserved).toBe(0);
      expect(result.lastHcmAsOf).toBeNull();
      expect(hcm.callsTo.getBalance).toBe(0); // HCM not called

      // Row persisted (legacy zero-on-miss)
      const persisted = await getRow(balanceRepo, 'emp1', 'loc1');
      expect(persisted).not.toBeNull();
      expect(persisted!.available).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // (f) Regression S16 — submit on cold cache does NOT deadlock.
  // ---------------------------------------------------------------------------
  describe('(f) regression S16 — submit on cold cache does not deadlock', () => {
    const { builder, hcm } = createTestModule();
    let moduleRef: TestingModule;
    let timeOffSvc: TimeOffRequestService;
    let balanceRepo: Repository<Balance>;

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      timeOffSvc = moduleRef.get(TimeOffRequestService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      hcm.reset();
    });

    afterEach(() => moduleRef.close());

    it('submit on cold cache does NOT deadlock (regression for e2e S16)', async () => {
      // Seed HCM so lazy-hydrate succeeds. Do NOT pre-seed the local Balance row
      // — the tuple is cold (lastHcmAsOf === null / absent).
      hcm.seedBalance('cold_submit_emp', 'loc1', 15);

      const submit = timeOffSvc.submit(
        'cold_submit_emp',
        'loc1',
        '2026-06-01',
        '2026-06-02',
        'cold-key-1',
      );

      // Race: if the deadlock returns the promise will never settle — fail fast.
      const result = await Promise.race([
        submit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('submit deadlocked')), 5000),
        ),
      ]);

      // Request created successfully
      expect(result.status).toBe(RequestStatus.PENDING);

      // Balance row was hydrated by the lazy-load path
      const row = await getRow(balanceRepo, 'cold_submit_emp', 'loc1');
      expect(row).not.toBeNull();
      expect(row!.lastHcmAsOf).not.toBeNull();
      expect(row!.available).toBe(15);
      // 2 business days reserved (Mon 2026-06-01 + Tue 2026-06-02)
      expect(row!.reserved).toBe(2);
    });
  });
});
