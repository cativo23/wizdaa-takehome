/**
 * cancel-and-reaper.spec.ts
 *
 * Phase 3 — Cancel + Reaper + Outbox Idempotency slice of the E1-E28 matrix.
 * Tests E9, E15, E16, E24, E27 (a & b), plus balance arithmetic invariants.
 *
 * Per-test isolation: createTestModule() is called inside beforeEach so each
 * test gets a fresh FakeClock, FakeHcmClient, and in-memory SQLite DB.
 */

import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  createTestModule,
  seedBalance,
  runDispatcherOnce,
  runReaperOnce,
} from '../testing';

import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import {
  RequestStatus,
  OutboxOperation,
  OutboxStatus,
} from '../entities/enums';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { OutboxDispatcherService } from '../hcm/outbox-dispatcher.service';
import { ReservationReaperService } from '../reservation-reaper/reservation-reaper.service';

// ---------------------------------------------------------------------------
// E9 — Cancel approved request → available restored, REVERSE filed once
// ---------------------------------------------------------------------------

describe('E9 — Cancel approved request → available restored, REVERSE filed once', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;
  let dispatcher: OutboxDispatcherService;
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

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
    hcm.setScenario('correct');
  });

  afterEach(() => moduleRef.close());

  it('cancel after approval: restores available, enqueues REVERSE, and REVERSE dispatches to HCM exactly once', async () => {
    // Submit 2 days (Mon-Tue Jun 1-2 = 2 business days)
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e9');
    expect(req.status).toBe(RequestStatus.PENDING);

    // Approve → PENDING_SYNC (pure outbox model)
    const approved = await svc.approve(req.id, 'manager1');
    expect(approved.status).toBe(RequestStatus.PENDING_SYNC);

    // Run dispatcher once → FILE dispatched; request transitions to APPROVED
    await runDispatcherOnce(dispatcher);
    const afterDispatch = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(afterDispatch.status).toBe(RequestStatus.APPROVED);

    // HCM balance should be 10 - 2 = 8 after FILE
    const hcmBalAfterFile = await hcm.getBalance('emp1', 'loc1');
    expect(hcmBalAfterFile.balance).toBe(8);
    // Reset the counter after the check call above
    hcm.callsTo.getBalance = 0;

    // Cancel the approved request
    const cancelled = await svc.cancel(req.id, 'emp1');
    expect(cancelled.status).toBe(RequestStatus.CANCELLED);

    // Local balance: available should be restored to 10
    const balAfterCancel = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterCancel.available).toBe(10);
    expect(balAfterCancel.reserved).toBe(0);

    // A REVERSE outbox row with PENDING status should exist
    const allOutbox = await outboxRepo.find({ where: { aggregateId: req.id } });
    const reverseRow = allOutbox.find((o) => o.operation === OutboxOperation.REVERSE);
    expect(reverseRow).toBeDefined();
    expect(reverseRow!.status).toBe(OutboxStatus.PENDING);
    // Idempotency key must end in ':REVERSE'
    expect(reverseRow!.idempotencyKey).toMatch(/:REVERSE$/);

    // Reset call counters before dispatcher run
    hcm.callsTo.reverseTimeOff = 0;
    hcm.callsTo.fileTimeOff = 0;

    // Run dispatcher once — REVERSE should be sent
    await runDispatcherOnce(dispatcher);

    const reverseRowAfter = await outboxRepo.findOneOrFail({ where: { id: reverseRow!.id } });
    expect(reverseRowAfter.status).toBe(OutboxStatus.SENT);

    // hcmAckAt on the request should be updated after REVERSE dispatch
    const finalRequest = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(finalRequest.hcmAckAt).not.toBeNull();

    // HCM balance should be back to 10 after REVERSE
    const hcmBalAfterReverse = await hcm.getBalance('emp1', 'loc1');
    expect(hcmBalAfterReverse.balance).toBe(10);

    // REVERSE was called exactly once at HCM
    expect(hcm.callsTo.reverseTimeOff).toBe(1);
  });

  it('running dispatcher twice after cancel does NOT double-apply the REVERSE (idempotency)', async () => {
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e9-idem');
    await svc.approve(req.id, 'manager1');
    await runDispatcherOnce(dispatcher);

    // Verify APPROVED
    const afterDispatch = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(afterDispatch.status).toBe(RequestStatus.APPROVED);

    // Cancel
    await svc.cancel(req.id, 'emp1');

    // Reset counters
    hcm.callsTo.reverseTimeOff = 0;

    // Dispatch twice
    await runDispatcherOnce(dispatcher);
    await runDispatcherOnce(dispatcher);

    // reverseTimeOff should have been called exactly once (second pass sees SENT, skips)
    expect(hcm.callsTo.reverseTimeOff).toBe(1);

    // HCM balance is 10 (not 12 from double-credit)
    const finalHcmBal = await hcm.getBalance('emp1', 'loc1');
    expect(finalHcmBal.balance).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// E15 — Reservation past TTL → EXPIRED, reserved released, pending FILE voided
// ---------------------------------------------------------------------------

describe('E15 — Reservation past TTL → EXPIRED, reserved released', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;
  let reaper: ReservationReaperService;
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
    reaper = moduleRef.get(ReservationReaperService);

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(() => moduleRef.close());

  it('PENDING request past TTL → EXPIRED; available=10, reserved=0, no outbox rows', async () => {
    // Submit 2 days (PENDING). No approval — stays PENDING.
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e15');
    expect(req.status).toBe(RequestStatus.PENDING);

    // Balance: available=10, reserved=2
    const balAfterSubmit = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterSubmit.available).toBe(10);
    expect(balAfterSubmit.reserved).toBe(2);

    // Advance clock past 14-day TTL
    clock.advance(15 * 24 * 60 * 60 * 1000);

    // Run reaper
    await runReaperOnce(reaper);

    // Request should be EXPIRED
    const expired = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(expired.status).toBe(RequestStatus.EXPIRED);

    // Balance: available=10, reserved=0 (release was called, not restore)
    const balAfterExpiry = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterExpiry.available).toBe(10);
    expect(balAfterExpiry.reserved).toBe(0);

    // For a PENDING request: no FILE was ever enqueued (approve was never called)
    // so Outbox count should be 0
    const outboxRows = await outboxRepo.find({ where: { aggregateId: req.id } });
    expect(outboxRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E16 — Double cancel (same request)
// ---------------------------------------------------------------------------

describe('E16 — Double cancel (same request, idempotent)', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;
  let dispatcher: OutboxDispatcherService;
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

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
    hcm.setScenario('correct');
  });

  afterEach(() => moduleRef.close());

  it('second cancel is a no-op: returns same CANCELLED request, no new REVERSE, no double-restore', async () => {
    // Submit → approve → dispatch (→ APPROVED)
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e16');
    await svc.approve(req.id, 'manager1');
    await runDispatcherOnce(dispatcher);

    const afterDispatch = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(afterDispatch.status).toBe(RequestStatus.APPROVED);

    // First cancel
    const firstCancel = await svc.cancel(req.id, 'emp1');
    expect(firstCancel.status).toBe(RequestStatus.CANCELLED);

    // Capture balance and outbox state after first cancel
    const balAfterFirstCancel = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterFirstCancel.available).toBe(10); // restored
    expect(balAfterFirstCancel.reserved).toBe(0);

    const outboxAfterFirst = await outboxRepo.find({ where: { aggregateId: req.id } });
    const reverseRowsAfterFirst = outboxAfterFirst.filter(
      (o) => o.operation === OutboxOperation.REVERSE,
    );
    expect(reverseRowsAfterFirst).toHaveLength(1); // exactly one REVERSE row

    // Second cancel — must be idempotent
    const secondCancel = await svc.cancel(req.id, 'emp1');
    expect(secondCancel.status).toBe(RequestStatus.CANCELLED);
    // Same request id
    expect(secondCancel.id).toBe(firstCancel.id);

    // No new REVERSE row enqueued (still exactly 1)
    const outboxAfterSecond = await outboxRepo.find({ where: { aggregateId: req.id } });
    const reverseRowsAfterSecond = outboxAfterSecond.filter(
      (o) => o.operation === OutboxOperation.REVERSE,
    );
    expect(reverseRowsAfterSecond).toHaveLength(1);

    // Balance has NOT been double-restored — available is still 10, not 12
    const balAfterSecondCancel = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterSecondCancel.available).toBe(10);
    expect(balAfterSecondCancel.reserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E24 — Reaper expires PENDING_SYNC with FILE in-flight
// ---------------------------------------------------------------------------

describe('E24 — Reaper expires PENDING_SYNC with FILE in-flight', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let outboxRepo: Repository<Outbox>;
  let dispatcher: OutboxDispatcherService;
  let reaper: ReservationReaperService;
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

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(() => moduleRef.close());

  it('PENDING_SYNC past TTL → EXPIRED; restore (not release) runs; FILE row VOIDED; dispatcher skips it', async () => {
    // Use 'timeout' scenario: HCM unavailable at approve-time getBalance, so request stays
    // PENDING_SYNC after approve (commit runs, FILE row enqueued). FILE dispatch will fail.
    hcm.setScenario('timeout');

    // Submit 2 days
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e24');
    expect(req.status).toBe(RequestStatus.PENDING);

    // Approve — HCM getBalance throws HcmUnavailableError (timeout scenario).
    // approve() falls through to PENDING_SYNC: commit runs, FILE outbox row enqueued.
    const pendingSync = await svc.approve(req.id, 'manager1');
    expect(pendingSync.status).toBe(RequestStatus.PENDING_SYNC);

    // Balance after approve: available -= 2, reserved -= 2 (commit ran)
    const balAfterApprove = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterApprove.available).toBe(8);
    expect(balAfterApprove.reserved).toBe(0);

    // FILE outbox row should be PENDING (dispatcher not yet run)
    const outboxBeforeReaper = await outboxRepo.find({ where: { aggregateId: req.id } });
    const fileRowBefore = outboxBeforeReaper.find((o) => o.operation === OutboxOperation.FILE);
    expect(fileRowBefore).toBeDefined();
    expect(fileRowBefore!.status).toBe(OutboxStatus.PENDING);

    // Advance clock past TTL — DO NOT run dispatcher
    clock.advance(15 * 24 * 60 * 60 * 1000);

    // Run reaper — should expire the PENDING_SYNC request
    await runReaperOnce(reaper);

    // Request status: EXPIRED
    const expired = await requestRepo.findOneOrFail({ where: { id: req.id } });
    expect(expired.status).toBe(RequestStatus.EXPIRED);

    // Balance: restore() was called (PENDING_SYNC → available += 2, not release/reserved-=2)
    // available should be back to 10
    const balAfterReaper = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterReaper.available).toBe(10);
    expect(balAfterReaper.reserved).toBe(0);

    // FILE outbox row should now be VOIDED (voided in same txn as expiry — B2)
    const fileRowAfter = await outboxRepo.findOneOrFail({ where: { id: fileRowBefore!.id } });
    expect(fileRowAfter.status).toBe(OutboxStatus.VOIDED);

    // Reset call counters
    hcm.callsTo.fileTimeOff = 0;

    // Run dispatcher — it should see the VOIDED row and skip it (no HCM call)
    await runDispatcherOnce(dispatcher);

    expect(hcm.callsTo.fileTimeOff).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E27 — Cancel a PENDING_SYNC request
// ---------------------------------------------------------------------------

describe('E27 — Cancel a PENDING_SYNC request', () => {
  // E27.a — FILE NOT YET SENT: cancel before running dispatcher
  describe('E27.a — FILE not yet sent: void FILE, restore balance, no REVERSE', () => {
    let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
    let svc: TimeOffRequestService;
    let balanceRepo: Repository<Balance>;
    let requestRepo: Repository<TimeOffRequest>;
    let outboxRepo: Repository<Outbox>;
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

      await seedBalance(balanceRepo, { available: 10, reserved: 0 });
      hcm.seedBalance('emp1', 'loc1', 10);
      // 'timeout' → getBalance throws → approve() can't refresh HCM balance
      // but still commits (balance committed, FILE PENDING). No HCM FILE dispatch yet.
      hcm.setScenario('timeout');
    });

    afterEach(() => moduleRef.close());

    it('PENDING_SYNC + FILE unsent → CANCELLED, FILE VOIDED, available restored, no REVERSE row', async () => {
      // Submit 2 days
      const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e27a');
      expect(req.status).toBe(RequestStatus.PENDING);

      // Approve under timeout: HCM getBalance fails → proceeds on local cache;
      // commit runs → available=8, reserved=0; FILE outbox row written; status=PENDING_SYNC
      const pendingSync = await svc.approve(req.id, 'manager1');
      expect(pendingSync.status).toBe(RequestStatus.PENDING_SYNC);

      // Balance after approve: commit ran
      const balAfterApprove = await balanceRepo.findOneOrFail({
        where: { employeeId: 'emp1', locationId: 'loc1' },
      });
      expect(balAfterApprove.available).toBe(8);
      expect(balAfterApprove.reserved).toBe(0);

      // FILE row should be PENDING
      const outboxBefore = await outboxRepo.find({ where: { aggregateId: req.id } });
      const fileRow = outboxBefore.find((o) => o.operation === OutboxOperation.FILE);
      expect(fileRow).toBeDefined();
      expect(fileRow!.status).toBe(OutboxStatus.PENDING);

      // Cancel immediately (before dispatcher runs) — FILE not yet sent
      const cancelled = await svc.cancel(req.id, 'emp1');
      expect(cancelled.status).toBe(RequestStatus.CANCELLED);

      // Balance restored: available back to 10
      const balAfterCancel = await balanceRepo.findOneOrFail({
        where: { employeeId: 'emp1', locationId: 'loc1' },
      });
      expect(balAfterCancel.available).toBe(10);
      expect(balAfterCancel.reserved).toBe(0);

      // FILE row should be VOIDED
      const fileRowAfter = await outboxRepo.findOneOrFail({ where: { id: fileRow!.id } });
      expect(fileRowAfter.status).toBe(OutboxStatus.VOIDED);

      // No REVERSE row should exist (FILE was voided, nothing landed at HCM)
      const allOutbox = await outboxRepo.find({ where: { aggregateId: req.id } });
      const reverseRows = allOutbox.filter((o) => o.operation === OutboxOperation.REVERSE);
      expect(reverseRows).toHaveLength(0);
    });
  });

  // E27.b — FILE ALREADY SENT: manual outbox mutation approach
  // To test "cancel of PENDING_SYNC where FILE is already SENT" we need to race the
  // dispatcher with the cancel. We simulate this by directly mutating the outbox row
  // to SENT status via the repo (and marking the request as PENDING_SYNC) before
  // calling cancel. This simulates the dispatcher having already sent the FILE to HCM
  // but the request status update being racy (still PENDING_SYNC visible to cancel).
  describe('E27.b — FILE already sent: REVERSE enqueued, balance restored', () => {
    let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
    let svc: TimeOffRequestService;
    let balanceRepo: Repository<Balance>;
    let requestRepo: Repository<TimeOffRequest>;
    let outboxRepo: Repository<Outbox>;
    let dispatcher: OutboxDispatcherService;
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

      await seedBalance(balanceRepo, { available: 10, reserved: 0 });
      hcm.seedBalance('emp1', 'loc1', 10);
    });

    afterEach(() => moduleRef.close());

    it('PENDING_SYNC + FILE already SENT (manual mutation) → CANCELLED, REVERSE enqueued, available restored', async () => {
      // Use 'timeout' to put request into PENDING_SYNC state after approve
      hcm.setScenario('timeout');

      const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-e27b');
      expect(req.status).toBe(RequestStatus.PENDING);

      // Approve → PENDING_SYNC (commit ran, FILE PENDING)
      const pendingSync = await svc.approve(req.id, 'manager1');
      expect(pendingSync.status).toBe(RequestStatus.PENDING_SYNC);

      // Verify FILE row is PENDING
      const outboxBeforeMutation = await outboxRepo.find({ where: { aggregateId: req.id } });
      const fileRow = outboxBeforeMutation.find((o) => o.operation === OutboxOperation.FILE);
      expect(fileRow).toBeDefined();
      expect(fileRow!.status).toBe(OutboxStatus.PENDING);

      // --- Manual outbox mutation ---
      // Simulate: the dispatcher already sent the FILE to HCM but the request status
      // update was racy and still shows PENDING_SYNC. We directly mutate the outbox row
      // to SENT to replicate the "FILE already sent" branch in cancel().
      await outboxRepo.update({ id: fileRow!.id }, { status: OutboxStatus.SENT });

      // Verify the mutation took effect
      const fileRowAfterMutation = await outboxRepo.findOneOrFail({ where: { id: fileRow!.id } });
      expect(fileRowAfterMutation.status).toBe(OutboxStatus.SENT);

      // Now cancel the PENDING_SYNC request (FILE is SENT → should restore + enqueue REVERSE)
      const cancelled = await svc.cancel(req.id, 'emp1');
      expect(cancelled.status).toBe(RequestStatus.CANCELLED);

      // Balance should be restored (available back to 10)
      const balAfterCancel = await balanceRepo.findOneOrFail({
        where: { employeeId: 'emp1', locationId: 'loc1' },
      });
      expect(balAfterCancel.available).toBe(10);
      expect(balAfterCancel.reserved).toBe(0);

      // A REVERSE row should exist (PENDING)
      const allOutbox = await outboxRepo.find({ where: { aggregateId: req.id } });
      const reverseRows = allOutbox.filter((o) => o.operation === OutboxOperation.REVERSE);
      expect(reverseRows).toHaveLength(1);
      expect(reverseRows[0].status).toBe(OutboxStatus.PENDING);
      // idempotency key ends in ':REVERSE'
      expect(reverseRows[0].idempotencyKey).toMatch(/:REVERSE$/);
    });
  });
});

// ---------------------------------------------------------------------------
// Balance arithmetic — Model A invariants (B-trace)
// ---------------------------------------------------------------------------

describe('balance arithmetic — Model A invariants', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof createTestModule>['builder']['compile']>>;
  let svc: TimeOffRequestService;
  let balanceRepo: Repository<Balance>;
  let dispatcher: OutboxDispatcherService;
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
    dispatcher = moduleRef.get(OutboxDispatcherService);

    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    hcm.seedBalance('emp1', 'loc1', 10);
    hcm.setScenario('correct');
  });

  afterEach(() => moduleRef.close());

  it('submit reserves days without touching available; reject releases reserved', async () => {
    // Submit 2 days (Jun 1-2 = 2 business days)
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-b-submit');

    // After submit: Model A → available unchanged, reserved += 2
    const balAfterSubmit = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterSubmit.available).toBe(10);
    expect(balAfterSubmit.reserved).toBe(2);

    // Reject: reserved -= 2 (release)
    await svc.reject(req.id, 'manager1');

    const balAfterReject = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterReject.available).toBe(10);
    expect(balAfterReject.reserved).toBe(0);
  });

  it('submit → approve → dispatcher → available=8, reserved=0; cancel → available=10, reserved=0', async () => {
    // Submit 2 days
    const req = await svc.submit('emp1', 'loc1', '2026-06-01', '2026-06-02', 'key-b-cancel');

    // Approve (pure outbox: commit → available-=2, reserved-=2, PENDING_SYNC)
    await svc.approve(req.id, 'manager1');

    // Dispatch → APPROVED
    await runDispatcherOnce(dispatcher);

    const approvedReq = await svc['requestRepo'].findOneOrFail({ where: { id: req.id } });
    expect(approvedReq.status).toBe(RequestStatus.APPROVED);

    const balAfterApprove = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    // Commit: available -= 2
    expect(balAfterApprove.available).toBe(8);
    expect(balAfterApprove.reserved).toBe(0);

    // Cancel: restore() → available += 2
    await svc.cancel(req.id, 'emp1');

    const balAfterCancel = await balanceRepo.findOneOrFail({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(balAfterCancel.available).toBe(10);
    expect(balAfterCancel.reserved).toBe(0);
  });
});
