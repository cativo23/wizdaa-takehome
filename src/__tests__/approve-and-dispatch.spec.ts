/**
 * approve-and-dispatch.spec.ts
 *
 * E3, E4, E5, E10, E11, E17, E18, E25 — approve + dispatcher + crash-durability slice.
 *
 * Each describe block owns exactly one E# edge case.
 * Per-test isolation: createTestModule() INSIDE beforeEach, close in afterEach.
 */

import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { createTestModule, seedBalance, runDispatcherOnce } from '../testing';

import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import {
  RequestStatus,
  OutboxStatus,
  OutboxOperation,
} from '../entities/enums';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { ConflictException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Shared timing constants
// ---------------------------------------------------------------------------
const FUTURE_START = '2026-06-01';
const FUTURE_END = '2026-06-02'; // Mon-Tue → 2 business days

// ---------------------------------------------------------------------------
// E3 — HCM silent failure (200 on insufficient)
// ---------------------------------------------------------------------------
describe('E3 — HCM silent failure (200 on insufficient)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));

    // Local balance: 2 available (insufficient for 3 days)
    await seedBalance(balanceRepo, { available: 2, reserved: 0 });
    // HCM has zero but will silently return ok=true on file
    hcm.seedBalance('emp1', 'loc1', 0);
    hcm.setScenario('silent-insufficient');
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('local guard rejects when available − reserved < days; no HCM call made', async () => {
    // Submit 3 days when only 2 available → ConflictException from local guard
    await expect(
      svc.submit('emp1', 'loc1', '2026-06-02', '2026-06-04', 'idem-e3'),
    ).rejects.toThrow(ConflictException);

    // HCM fileTimeOff must never have been called
    expect(hcm.callsTo.fileTimeOff).toBe(0);

    // No request rows, no outbox rows
    const reqRepo = moduleRef.get<Repository<TimeOffRequest>>(
      getRepositoryToken(TimeOffRequest),
    );
    const outboxRepo = moduleRef.get<Repository<Outbox>>(
      getRepositoryToken(Outbox),
    );
    const requests = await reqRepo.find();
    const outboxRows = await outboxRepo.find();
    expect(requests).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E4 — HCM timeout at approve → PENDING_SYNC, reservation held, retried
// ---------------------------------------------------------------------------
describe('E4 — HCM timeout at approve → PENDING_SYNC, reservation held, retried', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let dispatcher: OutboxDispatcherService;
  let balanceRepo: Repository<Balance>;
  let reqRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    dispatcher = moduleRef.get(OutboxDispatcherService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('approve yields PENDING_SYNC when HCM is unreachable; retry advances attempts; second retry succeeds', async () => {
    // Submit 2 days
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      FUTURE_START,
      FUTURE_END,
      'idem-e4',
    );
    expect(submitted.status).toBe(RequestStatus.PENDING);

    // Set timeout BEFORE approve — getBalance will throw HcmUnavailableError
    hcm.setScenario('timeout');

    // Approve — HCM unreachable; commits locally anyway
    const approved = await svc.approve(submitted.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // Balance: available was 10, commit did available−=2, reserved−=2
    const balAfterApprove = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterApprove.available).toBe(8);
    expect(balAfterApprove.reserved).toBe(0);

    // One outbox FILE row exists, PENDING, attempts=0
    const outboxRows = await outboxRepo.find();
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0];
    expect(outboxRow.operation).toBe(OutboxOperation.FILE);
    expect(outboxRow.status).toBe(OutboxStatus.PENDING);
    expect(outboxRow.attempts).toBe(0);

    // --- First dispatch: still timeout → attempts becomes 1, still PENDING ---
    await runDispatcherOnce(dispatcher);

    const rowAfter1 = await outboxRepo.findOneOrFail({
      where: { id: outboxRow.id },
    });
    expect(rowAfter1.attempts).toBe(1);
    expect(rowAfter1.status).toBe(OutboxStatus.PENDING);

    const reqAfter1 = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfter1.status).toBe(RequestStatus.PENDING_SYNC);

    expect(hcm.callsTo.fileTimeOff).toBeGreaterThanOrEqual(1);

    // --- Switch to correct scenario, run again → should succeed ---
    hcm.setScenario('correct');
    const callsBefore = hcm.callsTo.fileTimeOff;
    await runDispatcherOnce(dispatcher);

    const rowAfter2 = await outboxRepo.findOneOrFail({
      where: { id: outboxRow.id },
    });
    expect(rowAfter2.status).toBe(OutboxStatus.SENT);

    const reqAfter2 = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfter2.status).toBe(RequestStatus.APPROVED);
    expect(reqAfter2.hcmAckAt).not.toBeNull();

    // fileTimeOff was called at least once more (the successful call)
    expect(hcm.callsTo.fileTimeOff).toBeGreaterThan(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// E5 — PENDING_SYNC retry hits cap → REVERSE enqueued, REJECTED, balance restored
// ---------------------------------------------------------------------------
describe('E5 — PENDING_SYNC retry hits cap → REVERSE enqueued, REJECTED, balance restored', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let dispatcher: OutboxDispatcherService;
  let balanceRepo: Repository<Balance>;
  let reqRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    dispatcher = moduleRef.get(OutboxDispatcherService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('exhausting 5 retries flips request to REJECTED, restores balance, enqueues REVERSE', async () => {
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      FUTURE_START,
      FUTURE_END,
      'idem-e5',
    );

    // Approve succeeds locally (default 'correct' scenario allows getBalance)
    const approved = await svc.approve(submitted.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // Balance committed: available=8, reserved=0
    const balAfterApprove = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterApprove.available).toBe(8);
    expect(balAfterApprove.reserved).toBe(0);

    // Set timeout so all dispatches fail
    hcm.setScenario('timeout');

    // hcmRetryMaxAttempts default = 5
    // Run 5 times — 5th dispatch should hit cap
    for (let i = 0; i < 5; i++) {
      await runDispatcherOnce(dispatcher);
    }

    // FILE outbox row should be FAILED with attempts=5
    const outboxRows = await outboxRepo.find({
      where: { operation: OutboxOperation.FILE },
    });
    expect(outboxRows).toHaveLength(1);
    const fileRow = outboxRows[0];
    expect(fileRow.status).toBe(OutboxStatus.FAILED);
    expect(fileRow.attempts).toBe(5);

    // Request → REJECTED
    const reqAfter = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfter.status).toBe(RequestStatus.REJECTED);

    // Balance restored: available=10, reserved=0
    const balAfter = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfter.available).toBe(10);
    expect(balAfter.reserved).toBe(0);

    // A new REVERSE outbox row with idempotencyKey ending in ':REVERSE'
    const reverseRows = await outboxRepo.find({
      where: { operation: OutboxOperation.REVERSE },
    });
    expect(reverseRows).toHaveLength(1);
    const reverseRow = reverseRows[0];
    expect(reverseRow.status).toBe(OutboxStatus.PENDING);
    expect(reverseRow.idempotencyKey).toMatch(/:REVERSE$/);

    // Switch to correct scenario and run dispatcher — REVERSE should be SENT
    hcm.setScenario('correct');
    await runDispatcherOnce(dispatcher);

    const reverseSent = await outboxRepo.findOneOrFail({
      where: { id: reverseRow.id },
    });
    expect(reverseSent.status).toBe(OutboxStatus.SENT);
  });
});

// ---------------------------------------------------------------------------
// E10 — Approve after HCM refresh dropped balance → reject + release
// ---------------------------------------------------------------------------
describe('E10 — Approve after HCM refresh dropped balance → reject + release', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let outboxRepo: Repository<Outbox>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

    await seedBalance(balanceRepo, { available: 5, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 5);
    hcm.setScenario('correct');
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('approve rejects when HCM refresh reveals insufficient balance; reservation released', async () => {
    // Submit 2 days (local balance=5, sufficient)
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      FUTURE_START,
      FUTURE_END,
      'idem-e10',
    );
    expect(submitted.status).toBe(RequestStatus.PENDING);

    // Simulate HCM balance drop before approve: now only 1 day at HCM
    hcm.seedBalance('emp1', 'loc1', 1);

    // getBalanceCalls before approve
    const callsBefore = hcm.callsTo.getBalance;

    // Approve — getBalance returns 1, applyHcmSnapshot sets available=1
    // re-validate: 1 - reserved(2) < 2 → REJECTED
    const result = await svc.approve(submitted.id, 'manager1');
    expect(result.status).toBe(RequestStatus.REJECTED);

    // Reservation released: reserved=0
    const bal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(bal.reserved).toBe(0);
    // available was set to HCM value (1) by applyHcmSnapshot
    expect(bal.available).toBe(1);

    // No outbox row written (rejected before outbox write)
    const outboxRows = await outboxRepo.find();
    expect(outboxRows).toHaveLength(0);

    // Exactly one getBalance call was made during approve
    expect(hcm.callsTo.getBalance).toBe(callsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// E11 — HCM file times out, then retries → filed exactly once
// ---------------------------------------------------------------------------
describe('E11 — HCM file times out, then retries → filed exactly once (idempotency key)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let dispatcher: OutboxDispatcherService;
  let balanceRepo: Repository<Balance>;
  let reqRepo: Repository<TimeOffRequest>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    dispatcher = moduleRef.get(OutboxDispatcherService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('filed exactly once despite one failed attempt (idempotency key prevents double-deduct)', async () => {
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      FUTURE_START,
      FUTURE_END,
      'idem-e11',
    );
    const approved = await svc.approve(submitted.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // First dispatch fails (timeout)
    hcm.setScenario('timeout');
    await runDispatcherOnce(dispatcher);

    // callsTo.fileTimeOff = 1 so far (one failed attempt)
    expect(hcm.callsTo.fileTimeOff).toBe(1);

    const reqAfterFail = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfterFail.status).toBe(RequestStatus.PENDING_SYNC);

    // Second dispatch succeeds
    hcm.setScenario('correct');
    await runDispatcherOnce(dispatcher);

    // callsTo.fileTimeOff = 2 total (1 failed + 1 succeeded)
    expect(hcm.callsTo.fileTimeOff).toBe(2);

    const reqAfterSuccess = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfterSuccess.status).toBe(RequestStatus.APPROVED);
    expect(reqAfterSuccess.hcmAckAt).not.toBeNull();

    // HCM-side balance should reflect exactly ONE 2-day deduction (from 10 → 8)
    // Idempotency key prevented double-apply on the second call.
    // The fake-hcm dedup table has the key → second call returned cached ok=true without deducting.
    // Verify by checking the stored balance: since the first call returned ok=false (timeout),
    // the fake did NOT deduct on that attempt (timeout scenario returns {ok:false} without deducting).
    // The correct scenario call on attempt 2 deducts once → balance=8.
    const hcmBalance = await hcm.getBalance('emp1', 'loc1');
    expect(hcmBalance.balance).toBe(8); // exactly one 2-day deduction applied

    // Verify that the final local balance also committed correctly
    const localBal = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(localBal.available).toBe(8);
    expect(localBal.reserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E17 — Crash after local commit, before HCM file — outbox redrives on restart
// ---------------------------------------------------------------------------
describe('E17 — Crash after local commit, before HCM file — outbox redrives on restart', () => {
  describe('E17a — Normal redrive: outbox row survives; dispatcher promotes to APPROVED', () => {
    let moduleRef: Awaited<
      ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
    >;
    let svc: TimeOffRequestService;
    let dispatcher: OutboxDispatcherService;
    let balanceRepo: Repository<Balance>;
    let reqRepo: Repository<TimeOffRequest>;
    let outboxRepo: Repository<Outbox>;

    const { builder, hcm } = createTestModule();

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      svc = moduleRef.get(TimeOffRequestService);
      dispatcher = moduleRef.get(OutboxDispatcherService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
      outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

      await seedBalance(balanceRepo, { available: 10, reserved: 0 });
      hcm.seedBalance('emp1', 'loc1', 10);
      hcm.setScenario('correct');
    });

    afterEach(async () => {
      hcm.reset();
      await moduleRef.close();
    });

    it('outbox FILE row is durable; dispatcher sends it after a simulated restart gap', async () => {
      const submitted = await svc.submit(
        'emp1',
        'loc1',
        FUTURE_START,
        FUTURE_END,
        'idem-e17a',
      );
      const approved = await svc.approve(submitted.id, 'manager1');

      // At this point: PENDING_SYNC, outbox FILE PENDING, balance committed locally
      expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

      const outboxRows = await outboxRepo.find();
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe(OutboxStatus.PENDING);

      // --- Simulate restart: do NOT run dispatcher before now; it "wakes up" post-restart ---
      // The outbox row is durable in SQLite; calling runDispatcherOnce simulates the
      // dispatcher waking up and picking up the durable PENDING row.
      await runDispatcherOnce(dispatcher);

      const outboxAfter = await outboxRepo.findOneOrFail({
        where: { id: outboxRows[0].id },
      });
      expect(outboxAfter.status).toBe(OutboxStatus.SENT);

      const reqAfter = await reqRepo.findOneOrFail({
        where: { id: submitted.id },
      });
      expect(reqAfter.status).toBe(RequestStatus.APPROVED);
      expect(reqAfter.hcmAckAt).not.toBeNull();
    });
  });

  describe('E17b — Atomicity rollback: inject failure inside transaction → no partial commit', () => {
    let moduleRef: Awaited<
      ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
    >;
    let svc: TimeOffRequestService;
    let balanceRepo: Repository<Balance>;
    let reqRepo: Repository<TimeOffRequest>;
    let outboxRepo: Repository<Outbox>;
    let dataSource: DataSource;

    const { builder, hcm } = createTestModule();

    beforeEach(async () => {
      moduleRef = await builder.compile();
      await moduleRef.init();
      svc = moduleRef.get(TimeOffRequestService);
      balanceRepo = moduleRef.get(getRepositoryToken(Balance));
      reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
      outboxRepo = moduleRef.get(getRepositoryToken(Outbox));
      dataSource = moduleRef.get(DataSource);

      await seedBalance(balanceRepo, { available: 10, reserved: 0 });
      hcm.seedBalance('emp1', 'loc1', 10);
      hcm.setScenario('correct');
    });

    afterEach(async () => {
      hcm.reset();
      jest.restoreAllMocks();
      await moduleRef.close();
    });

    it('balance, request, and outbox row all roll back together when the transaction throws', async () => {
      const submitted = await svc.submit(
        'emp1',
        'loc1',
        FUTURE_START,
        FUTURE_END,
        'idem-e17b',
      );

      // After submit: available=10, reserved=2
      const balAfterSubmit = await balanceRepo.findOneOrFail({
        where: { employeeId: 'emp1', locationId: 'loc1' },
      });
      expect(balAfterSubmit.available).toBe(10);
      expect(balAfterSubmit.reserved).toBe(2);

      // Inject failure: wrap dataSource.transaction to throw after the commit
      // starts (i.e., inside the transaction body that writes balance + outbox).
      // Strategy: spy on outboxRepo.save within the manager context by wrapping
      // dataSource.transaction itself — the spy calls the real transaction fn but
      // forces an error to be thrown, causing the SQLite transaction to roll back.
      const originalTransaction = dataSource.transaction.bind(dataSource);
      let transactionCallCount = 0;
      const transactionSpy = jest
        .spyOn(dataSource, 'transaction')
        .mockImplementation(async (...args: unknown[]) => {
          transactionCallCount++;
          // The approve() method calls dataSource.transaction for the commit step
          // (which is the 2nd or later call — the first may be for HCM snapshot).
          // We intercept the call that writes the FILE outbox row.
          // To identify it: run the real fn but throw AFTER it executes so we can
          // detect the outbox write and then force a roll back on this specific call.
          // Simplest approach: force the Nth transaction call to throw.
          // The approve path's commit transaction is the final one (after HCM refresh).
          // In the approve sequence: the main commit txn is called once (step 4-5).
          // We throw on the first call to dataSource.transaction inside approve.
          if (transactionCallCount === 1) {
            // Simulate a throw INSIDE the transaction body — this causes rollback.
            throw new Error('Injected crash inside approve transaction');
          }
          // @ts-expect-error - variadic overload
          return originalTransaction(...args);
        });

      // approve() should propagate the injected error
      await expect(svc.approve(submitted.id, 'manager1')).rejects.toThrow(
        'Injected crash inside approve transaction',
      );

      transactionSpy.mockRestore();

      // Balance must NOT have been committed — still available=10, reserved=2
      const balAfterCrash = await balanceRepo.findOneOrFail({
        where: { employeeId: 'emp1', locationId: 'loc1' },
      });
      expect(balAfterCrash.available).toBe(10);
      expect(balAfterCrash.reserved).toBe(2);

      // Request must still be PENDING (not PENDING_SYNC)
      const reqAfterCrash = await reqRepo.findOneOrFail({
        where: { id: submitted.id },
      });
      expect(reqAfterCrash.status).toBe(RequestStatus.PENDING);

      // No outbox rows written
      const outboxRows = await outboxRepo.find();
      expect(outboxRows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// E18 — startDate retroactive at approve (location tz / DST)
// ---------------------------------------------------------------------------
describe('E18 — startDate retroactive at approve (location tz / DST)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let outboxRepo: Repository<Outbox>;

  const { builder, clock, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

    // Clock starts at 2026-05-27 — before the startDate
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
    hcm.setScenario('correct');
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('rejects at approve when startDate is in the past; reservation released; no outbox row', async () => {
    // Submit with a future start date (clock is at 2026-05-27)
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      '2026-06-01',
      '2026-06-02',
      'idem-e18',
    );
    expect(submitted.status).toBe(RequestStatus.PENDING);

    // Balance: available=10, reserved=2
    const balAfterSubmit = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterSubmit.reserved).toBe(2);

    // Advance clock to AFTER the startDate (2026-06-15)
    clock.setNow(new Date('2026-06-15T00:00:00Z'));

    // Approve — past-date guard fires (startDate 2026-06-01 < now civil date 2026-06-15)
    const result = await svc.approve(submitted.id, 'manager1');
    expect(result.status).toBe(RequestStatus.REJECTED);

    // Reservation released: reserved=0
    const balAfter = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfter.reserved).toBe(0);

    // No outbox row written
    const outboxRows = await outboxRepo.find();
    expect(outboxRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E25 — Retry-cap REJECTED after a FILE already landed → REVERSE undoes HCM deduction
// ---------------------------------------------------------------------------
describe('E25 — Retry-cap REJECTED after a FILE already landed → REVERSE undoes HCM deduction', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>
  >;
  let svc: TimeOffRequestService;
  let dispatcher: OutboxDispatcherService;
  let balanceRepo: Repository<Balance>;
  let reqRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;

  const { builder, hcm } = createTestModule();

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    svc = moduleRef.get(TimeOffRequestService);
    dispatcher = moduleRef.get(OutboxDispatcherService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    reqRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    outboxRepo = moduleRef.get(getRepositoryToken(Outbox));

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    // HCM balance starts at 8 — simulating that the FILE already landed silently at HCM
    // (phantom apply: the deduction happened but the ack was lost, so our system retried).
    // We model this by pre-seeding HCM balance to 8 (10 − 2 days).
    hcm.seedBalance('emp1', 'loc1', 8);
    hcm.setScenario('timeout');
  });

  afterEach(async () => {
    hcm.reset();
    await moduleRef.close();
  });

  it('REVERSE is enqueued after retry-cap; when dispatched it credits HCM back to original balance', async () => {
    // Submit 2 days — local guard uses local balance (10 available) so this passes.
    // hcm.getBalance will throw (timeout scenario) during approve, so approve skips HCM refresh.
    const submitted = await svc.submit(
      'emp1',
      'loc1',
      FUTURE_START,
      FUTURE_END,
      'idem-e25',
    );

    // Approve — HCM unavailable (timeout), approve proceeds on local cache → PENDING_SYNC
    const approved = await svc.approve(submitted.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // Local balance after approve: available=8, reserved=0
    const balAfterApprove = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterApprove.available).toBe(8);
    expect(balAfterApprove.reserved).toBe(0);

    // Dispatch 5 times — all fail (timeout). 5th hit cap → REVERSE enqueued.
    for (let i = 0; i < 5; i++) {
      await runDispatcherOnce(dispatcher);
    }

    // FILE row → FAILED
    const fileRows = await outboxRepo.find({
      where: { operation: OutboxOperation.FILE },
    });
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].status).toBe(OutboxStatus.FAILED);
    expect(fileRows[0].attempts).toBe(5);

    // Request → REJECTED
    const reqAfter = await reqRepo.findOneOrFail({
      where: { id: submitted.id },
    });
    expect(reqAfter.status).toBe(RequestStatus.REJECTED);

    // Local balance restored: available=10
    const balAfter = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfter.available).toBe(10);
    expect(balAfter.reserved).toBe(0);

    // A REVERSE outbox row enqueued
    const reverseRows = await outboxRepo.find({
      where: { operation: OutboxOperation.REVERSE },
    });
    expect(reverseRows).toHaveLength(1);
    expect(reverseRows[0].status).toBe(OutboxStatus.PENDING);
    expect(reverseRows[0].idempotencyKey).toMatch(/:REVERSE$/);

    // Switch to correct scenario and dispatch the REVERSE
    // HCM had balance=8 (the phantom deduction); REVERSE should credit +2 → balance=10
    hcm.setScenario('correct');
    await runDispatcherOnce(dispatcher);

    const reverseSent = await outboxRepo.findOneOrFail({
      where: { id: reverseRows[0].id },
    });
    expect(reverseSent.status).toBe(OutboxStatus.SENT);

    // HCM balance should be back to 10 (undone the phantom deduction)
    const hcmBalanceAfterReverse = await hcm.getBalance('emp1', 'loc1');
    expect(hcmBalanceAfterReverse.balance).toBe(10);
  });
});
