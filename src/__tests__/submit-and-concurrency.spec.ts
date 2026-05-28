/**
 * submit-and-concurrency.spec.ts
 *
 * Phase 3 — Submit + Concurrency slice of the E1-E28 matrix.
 * Tests E1, E2, E8, E19, E20, E21, E22, E23, E28.
 *
 * Each describe block maps to one matrix row. Services are exercised via
 * the real NestJS module using createTestModule (no service mocks).
 * Per-test isolation: createTestModule() called inside beforeEach so each
 * test gets a fresh FakeClock, FakeHcmClient, and in-memory SQLite DB.
 */

import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  createTestModule,
  seedBalance,
  withLockLatch,
  runDispatcherOnce,
  runReaperOnce,
} from '../testing';

import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { RequestStatus, OutboxStatus } from '../entities/enums';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { ReservationReaperService } from '../reservation-reaper/reservation-reaper.service';
import {
  BalanceLockService,
  balanceKey,
} from '../common/lock/balance-lock.service';

// ---------------------------------------------------------------------------
// E1 — Submit exceeding available
// ---------------------------------------------------------------------------

describe('E1 — Submit exceeding available', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    // Seed balance with 5 available days
    await seedBalance(balanceRepo, { available: 5, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('rejects at submit when the requested days exceed available − reserved', async () => {
    // Jun 1 (Mon) to Jun 8 (Mon) = 6 business days; balance only has 5
    await expect(
      svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-08', 'key-e1-a'),
    ).rejects.toThrow(ConflictException);
  });

  it('does not create a request row when submit is rejected for insufficient balance', async () => {
    await expect(
      svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-08', 'key-e1-b'),
    ).rejects.toThrow(ConflictException);

    const requests = await requestRepo.find();
    expect(requests).toHaveLength(0);
  });

  it('does not modify the balance when submit is rejected', async () => {
    await expect(
      svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-08', 'key-e1-c'),
    ).rejects.toThrow(ConflictException);

    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(bal.available).toBe(5);
    expect(bal.reserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E2 — Two concurrent submits, only one fits
// ---------------------------------------------------------------------------

describe('E2 — Two concurrent submits, only one fits', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let lockService: BalanceLockService;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    lockService = moduleRef.get(BalanceLockService);
    // Seed 4 available — only one 3-day request fits
    await seedBalance(balanceRepo, { available: 4, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('serializes concurrent submits: first succeeds, second gets ConflictException when balance only fits one', async () => {
    // Install latch so submit A enters the lock and pauses before B starts
    const latch = withLockLatch(lockService, 'emp1', 'loc1');

    // Start A — will enter the lock and pause at the latch
    // Jun 1-3 (Mon-Wed) = 3 business days (disjoint from B's Jun 8-10)
    const promiseA = svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-03',
      'key-e2-a',
    );

    // Wait until A is inside the critical section
    await latch.reached;

    // Fire B with a different, non-overlapping date range (Jun 8-10, Mon-Wed = 3 days)
    // B should be blocked behind A (promise not yet resolved)
    let bSettled = false;
    const promiseB = svc
      .submit('emp1', 'loc1', '2026-06-08', '2026-06-10', 'key-e2-b')
      .then((r) => {
        bSettled = true;
        return r;
      })
      .catch((e) => {
        bSettled = true;
        throw e;
      });

    // B has not yet started — it is queued behind A's lock
    expect(bSettled).toBe(false);

    // Release A
    latch.release();
    const resultA = await promiseA;

    // Now await B — it runs after A completes
    let resultB: TimeOffRequest | null = null;
    let errorB: unknown = null;
    try {
      resultB = await promiseB;
    } catch (e) {
      errorB = e;
    }

    // A must have succeeded — PENDING with reserved=3
    expect(resultA.status).toBe(RequestStatus.PENDING);
    expect(resultA.days).toBe(3);

    // B must have failed — balance only had 4, A reserved 3 → only 1 free
    expect(errorB).toBeInstanceOf(ConflictException);
    expect(resultB).toBeNull();

    // Final balance state: available=4 (Model A: reserve doesn't decrement available)
    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(bal.available).toBe(4);
    expect(bal.reserved).toBe(3);

    // Only one request row
    const allRequests = await requestRepo.find();
    expect(allRequests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E8 — Duplicate submit (same idempotency key)
// ---------------------------------------------------------------------------

describe('E8 — Duplicate submit (same idempotency key)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('returns the same request on duplicate submit without double-reserving', async () => {
    const IDEM_KEY = 'key-e8-dup';

    const first = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      IDEM_KEY,
    );
    const second = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      IDEM_KEY,
    );

    // Must return the same request id
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(RequestStatus.PENDING);
  });

  it('does not double-reserve balance on duplicate submit', async () => {
    const IDEM_KEY = 'key-e8-bal';

    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);
    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);

    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    // Jun 1-2 = 2 business days; reserved only once
    expect(bal.reserved).toBe(2);
  });

  it('keeps only one TimeOffRequest row after duplicate submit', async () => {
    const IDEM_KEY = 'key-e8-row';

    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);
    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);

    const rows = await requestRepo.find();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E19 — Two submits, same dates, different keys
// ---------------------------------------------------------------------------

describe('E19 — Two submits, same dates, different keys', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('allows the first submit and rejects the second with same dates but different idempotency keys', async () => {
    const first = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-03',
      'key-e19-a',
    );
    expect(first.status).toBe(RequestStatus.PENDING);

    await expect(
      svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-03', 'key-e19-b'),
    ).rejects.toThrow(ConflictException);
  });
});

// ---------------------------------------------------------------------------
// E20 — Boundary touch: Jan 5-6 then Jan 6-7 (shared Jan 6)
// ---------------------------------------------------------------------------

describe('E20 — Boundary touch: shared day causes overlap rejection', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('rejects boundary-touching range (Jan 5-6 then Jan 6-7 share Jan 6)', async () => {
    // Jan 5 2026 = Monday, Jan 6 = Tuesday, Jan 7 = Wednesday
    // Range 1: Jan 5-6 = 2 business days
    // Range 2: Jan 6-7 = 2 business days; shares Jan 6 with range 1
    const first = await svc.submit(
      'emp1',
      'loc1',
      '2026-01-05',
      '2026-01-06',
      'key-e20-a',
    );
    expect(first.status).toBe(RequestStatus.PENDING);

    await expect(
      svc.submit('emp1', 'loc1', '2026-01-06', '2026-01-07', 'key-e20-b'),
    ).rejects.toThrow(ConflictException);
  });
});

// ---------------------------------------------------------------------------
// E21 — Concurrent disjoint dates, balance fits both
// ---------------------------------------------------------------------------

describe('E21 — Concurrent disjoint dates, balance fits both', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    // 10 available — enough for both 2-day submits
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('both disjoint submits succeed and cumulative reserved equals 4 (Model A)', async () => {
    // Jun 1-2 (Mon-Tue, 2 days) and Jun 8-9 (Mon-Tue, 2 days) — disjoint
    const [resultA, resultB] = await Promise.all([
      svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e21-a'),
      svc.submit('emp1', 'loc1', '2026-06-08', '2026-06-09', 'key-e21-b'),
    ]);

    expect(resultA.status).toBe(RequestStatus.PENDING);
    expect(resultB.status).toBe(RequestStatus.PENDING);

    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    // Model A: available unchanged, reserved = sum of both reservations
    expect(bal.available).toBe(10);
    expect(bal.reserved).toBe(4);

    const rows = await requestRepo.find();
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// E22 — Concurrent disjoint dates, balance fits only one
// ---------------------------------------------------------------------------

describe('E22 — Concurrent disjoint dates, balance fits only one', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let lockService: BalanceLockService;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    lockService = moduleRef.get(BalanceLockService);
    // 4 available — only one 3-day reservation fits
    await seedBalance(balanceRepo, { available: 4, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('first submit reserves 3 days; second fails with ConflictException (insufficient)', async () => {
    // Use a latch to deterministically serialize: A goes first, then B
    const latch = withLockLatch(lockService, 'emp1', 'loc1');

    // Jun 1-3 (3 days) and Jun 8-10 (3 days) — disjoint
    const promiseA = svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-03',
      'key-e22-a',
    );
    await latch.reached;

    // B queued behind A
    let bError: unknown = null;
    const promiseB = svc
      .submit('emp1', 'loc1', '2026-06-08', '2026-06-10', 'key-e22-b')
      .catch((e) => {
        bError = e;
      });

    latch.release();
    const resultA = await promiseA;
    await promiseB;

    expect(resultA.status).toBe(RequestStatus.PENDING);
    expect(bError).toBeInstanceOf(ConflictException);

    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    // Model A: available unchanged (reserve doesn't decrement it), reserved=3
    expect(bal.available).toBe(4);
    expect(bal.reserved).toBe(3);

    const rows = await requestRepo.find();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E23 — Same key, different body
// ---------------------------------------------------------------------------

describe('E23 — Same key, different body (client bug)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeEach(async () => {
    const { builder } = createTestModule();
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
  });

  afterEach(() => moduleRef.close());

  it('throws UnprocessableEntityException (422) when the same key is submitted with a different body', async () => {
    const IDEM_KEY = 'key-e23-reuse';

    // First submit: Jun 1-2
    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);

    // Second submit: same key, different date range → 422
    await expect(
      svc.submit('emp1', 'loc1', '2026-06-08', '2026-06-09', IDEM_KEY),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('keeps only one request row in DB after key-reuse rejection', async () => {
    const IDEM_KEY = 'key-e23-row';

    await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', IDEM_KEY);

    await expect(
      svc.submit('emp1', 'loc1', '2026-06-08', '2026-06-09', IDEM_KEY),
    ).rejects.toThrow(UnprocessableEntityException);

    const rows = await requestRepo.find();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E28 — Resubmit after EXPIRE with same form key
// ---------------------------------------------------------------------------

describe('E28 — Resubmit after EXPIRE with same form key', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;
  let dispatcher: OutboxDispatcherService;
  let reaper: ReservationReaperService;
  // Need access to clock for time advance
  let clock: ReturnType<typeof createTestModule>['clock'];
  let hcm: ReturnType<typeof createTestModule>['hcm'];

  beforeEach(async () => {
    const handles = createTestModule();
    clock = handles.clock;
    hcm = handles.hcm;
    moduleRef = await handles.builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));
    dispatcher = moduleRef.get(OutboxDispatcherService);
    reaper = moduleRef.get(ReservationReaperService);
    // Seed enough balance for 2 requests
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(() => moduleRef.close());

  it('creates a NEW request when resubmitting with the same key after expiry', async () => {
    const IDEM_KEY = 'key-e28-resubmit';

    // 1. Submit first request (PENDING)
    const original = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      IDEM_KEY,
    );
    expect(original.status).toBe(RequestStatus.PENDING);

    // 2. Advance clock past the 14-day TTL (use 15 days)
    clock.advance(15 * 24 * 60 * 60 * 1000);

    // 3. Run reaper — the first request should expire
    await runReaperOnce(reaper);

    // Verify the original request is now EXPIRED
    const expired = await requestRepo.findOneOrFail({
      where: { id: original.id },
    });
    expect(expired.status).toBe(RequestStatus.EXPIRED);

    // 4. Resubmit with the same idempotency key but a new date range (original expired, so new submit allowed)
    // Use a future date well after TTL expiry — clock is now 2026-06-11 (2026-05-27 + 15 days)
    // Jun 15-16 (Mon-Tue) = 2 business days, won't overlap with the expired Jun 1-2 range
    const newRequest = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-15',
      '2026-06-16',
      IDEM_KEY,
    );

    // A NEW request must be created (different id)
    expect(newRequest.id).not.toBe(original.id);
    expect(newRequest.status).toBe(RequestStatus.PENDING);
  });

  it('mangles the old expired row idempotency key to free the UNIQUE constraint', async () => {
    const IDEM_KEY = 'key-e28-mangle';

    const original = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      IDEM_KEY,
    );

    clock.advance(15 * 24 * 60 * 60 * 1000);
    await runReaperOnce(reaper);

    // Resubmit — creates new row
    const newRequest = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-15',
      '2026-06-16',
      IDEM_KEY,
    );

    // Both rows should exist in DB
    const allRows = await requestRepo.find();
    expect(allRows).toHaveLength(2);

    // New request has the idempotency key
    const newRow = allRows.find((r) => r.id === newRequest.id);
    expect(newRow?.idempotencyKey).toBe(IDEM_KEY);

    // Old (expired) row has a mangled key (no longer the original key)
    const oldRow = allRows.find((r) => r.id === original.id);
    expect(oldRow?.idempotencyKey).not.toBe(IDEM_KEY);
    expect(oldRow?.status).toBe(RequestStatus.EXPIRED);
  });

  it('full E28 outbox approval flow: new request can be approved after resubmit', async () => {
    const IDEM_KEY = 'key-e28-approve';

    // Submit and expire original
    const original = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      IDEM_KEY,
    );
    clock.advance(15 * 24 * 60 * 60 * 1000);
    await runReaperOnce(reaper);

    // Reload: original should be expired, reserved released
    const expiredRow = await requestRepo.findOneOrFail({
      where: { id: original.id },
    });
    expect(expiredRow.status).toBe(RequestStatus.EXPIRED);

    // Verify balance released (reserved back to 0 after expiry)
    const balAfterExpiry = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterExpiry.reserved).toBe(0);

    // Resubmit with same key but future dates
    // Clock is now 2026-05-27 + 15 days = 2026-06-11; use Jun 15-16
    const newRequest = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-15',
      '2026-06-16',
      IDEM_KEY,
    );
    expect(newRequest.status).toBe(RequestStatus.PENDING);

    // Approve the new request: Pure Outbox model → PENDING_SYNC + Outbox(FILE, PENDING)
    const approved = await svc.approve(newRequest.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // Verify outbox FILE row was written
    const outboxRows = await outboxRepo.find({
      where: { aggregateId: newRequest.id },
    });
    const fileRow = outboxRows.find((o) => o.status === OutboxStatus.PENDING);
    expect(fileRow).toBeDefined();

    // Run dispatcher → should mark FILE as SENT and move request to APPROVED
    await runDispatcherOnce(dispatcher);

    const finalRequest = await requestRepo.findOneOrFail({
      where: { id: newRequest.id },
    });
    expect(finalRequest.status).toBe(RequestStatus.APPROVED);
    expect(finalRequest.hcmAckAt).not.toBeNull();
  });
});
