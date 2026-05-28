/**
 * reconcile-extra.spec.ts — additional tests for ReconciliationService.
 *
 * Covers the public `reconcileBalance(emp, loc, hcmValue, asOf)` wrapper
 * (lines 152-163 in reconciliation.service.ts) which is NOT exercised by the
 * existing reconcile.spec.ts (that file only uses ingestBatch).
 *
 * Preferred as a NEW file to avoid modifying the previous agent's committed spec.
 */

import { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { createTestModule, seedBalance } from '../testing';
import { Balance } from '../entities/balance.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ReconResolution } from '../entities/enums';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function getBalance(repo: Repository<Balance>, emp = 'emp1', loc = 'loc1') {
  return repo.findOne({ where: { employeeId: emp, locationId: loc } });
}

// ---------------------------------------------------------------------------
// reconcileBalance (public one-balance wrapper)
// ---------------------------------------------------------------------------

describe('ReconciliationService.reconcileBalance (public wrapper, one-balance ingest)', () => {
  const { builder, hcm } = createTestModule();
  let moduleRef: TestingModule;
  let reconcileSvc: ReconciliationService;
  let balanceRepo: Repository<Balance>;
  let reconEventRepo: Repository<ReconciliationEvent>;

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();

    reconcileSvc = moduleRef.get(ReconciliationService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
    reconEventRepo = moduleRef.get(getRepositoryToken(ReconciliationEvent));

    hcm.reset();
  });

  afterEach(() => moduleRef.close());

  it('mirrors ingestBatch for a single entry: sets available and emits ReconciliationEvent', async () => {
    // Seed a pre-existing balance
    await seedBalance(balanceRepo, { available: 5, reserved: 0 });

    const asOf = new Date('2026-06-15T00:00:00Z');

    // Call the public wrapper directly (lines 152-163 in reconciliation.service.ts)
    await reconcileSvc.reconcileBalance('emp1', 'loc1', 12, asOf);

    const balance = await getBalance(balanceRepo);

    // available should be set to hcmValue (12) — no unacked approvals or pending reverses seeded.
    expect(balance?.available).toBe(12);
    expect(balance?.reserved).toBe(0);
    expect(balance?.lastHcmAsOf?.toISOString()).toBe(asOf.toISOString());
    expect(balance?.needsReview).toBe(false);

    // A ReconciliationEvent must have been emitted
    const event = await reconEventRepo.findOne({
      where: { employeeId: 'emp1', locationId: 'loc1' },
      order: { createdAt: 'DESC' },
    });
    expect(event).not.toBeNull();
    expect([ReconResolution.REPLAYED, ReconResolution.NO_CHANGE]).toContain(event?.resolution);
  });

  it('creates the zero balance row on first call then applies hcmValue', async () => {
    // No pre-existing row
    const before = await getBalance(balanceRepo);
    expect(before).toBeNull();

    const asOf = new Date('2026-06-20T00:00:00Z');
    await reconcileSvc.reconcileBalance('emp1', 'loc1', 7, asOf);

    const balance = await getBalance(balanceRepo);
    expect(balance).not.toBeNull();
    expect(balance?.available).toBe(7);
    expect(balance?.lastHcmAsOf?.toISOString()).toBe(asOf.toISOString());
  });

  it('sets needsReview when hcmValue drives available negative', async () => {
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });
    // hcmValue = -3 (pathological but theoretically possible)
    await reconcileSvc.reconcileBalance('emp1', 'loc1', -3, new Date('2026-06-15T00:00:00Z'));

    const balance = await getBalance(balanceRepo);
    expect(balance?.available).toBe(-3);
    expect(balance?.needsReview).toBe(true);

    const event = await reconEventRepo.findOne({
      where: { resolution: ReconResolution.FLAGGED_NEGATIVE },
    });
    expect(event).not.toBeNull();
  });
});
