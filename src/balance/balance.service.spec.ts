/**
 * balance.service.spec.ts — unit-style coverage for BalanceService gaps.
 *
 * Targets uncovered lines:
 *   70-78  findOrCreate fresh-record path (no existing row).
 *   108-132 saveWithRetry on OptimisticLockVersionMismatchError.
 *   153-161 validateAvailability when balance row doesn't exist (getBalance autocreate path).
 *
 * Strategy: use `createTestModule` from the harness; get real BalanceService.
 */

import { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, OptimisticLockVersionMismatchError } from 'typeorm';
import { ConflictException } from '@nestjs/common';

import { createTestModule, seedBalance } from '../testing';
import { Balance } from '../entities/balance.entity';
import { BalanceService } from './balance.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRow(repo: Repository<Balance>, emp = 'emp1', loc = 'loc1') {
  return repo.findOne({ where: { employeeId: emp, locationId: loc } });
}

// ---------------------------------------------------------------------------
// getBalance — fresh-record (findOrCreate) path (lines 70-78 / 153-161)
// ---------------------------------------------------------------------------

describe('BalanceService.getBalance — creates zero record on first access', () => {
  const { builder } = createTestModule();
  let moduleRef: TestingModule;
  let balanceSvc: BalanceService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    balanceSvc = moduleRef.get(BalanceService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
  });

  afterEach(() => moduleRef.close());

  it('creates and persists a zero balance row for a previously-unseen (emp, loc)', async () => {
    // No prior row exists
    const before = await getRow(balanceRepo, 'newEmp', 'newLoc');
    expect(before).toBeNull();

    const result = await balanceSvc.getBalance('newEmp', 'newLoc');

    expect(result.employeeId).toBe('newEmp');
    expect(result.locationId).toBe('newLoc');
    expect(result.available).toBe(0);
    expect(result.reserved).toBe(0);
    expect(result.needsReview).toBe(false);

    // Row must be persisted (not just returned in-memory)
    const after = await getRow(balanceRepo, 'newEmp', 'newLoc');
    expect(after).not.toBeNull();
    expect(after!.available).toBe(0);
  });

  it('returns the existing row on second call (no duplicate inserts)', async () => {
    // Pre-seed with a warm row (lastHcmAsOf set) — ADR-014 hot path:
    // a row with lastHcmAsOf !== null is returned directly without an HCM call.
    await seedBalance(balanceRepo, {
      available: 5,
      lastHcmAsOf: new Date('2026-05-01T00:00:00Z'),
    });

    const result = await balanceSvc.getBalance('emp1', 'loc1');

    expect(result.available).toBe(5);
    // Only one row exists
    const count = await balanceRepo.count({
      where: { employeeId: 'emp1', locationId: 'loc1' },
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validateAvailability — non-existent balance → autocreate zero-row then throw
// ---------------------------------------------------------------------------

describe('BalanceService.validateAvailability — non-existent balance', () => {
  const { builder } = createTestModule();
  let moduleRef: TestingModule;
  let balanceSvc: BalanceService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    balanceSvc = moduleRef.get(BalanceService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
  });

  afterEach(() => moduleRef.close());

  it('autocreates a zero balance row then throws ConflictException for any days > 0', async () => {
    // No row exists beforehand
    const before = await getRow(balanceRepo);
    expect(before).toBeNull();

    await expect(
      balanceSvc.validateAvailability('emp1', 'loc1', 1),
    ).rejects.toThrow(ConflictException);

    // The zero row must now exist (autocreated by getBalance inside validateAvailability)
    const after = await getRow(balanceRepo);
    expect(after).not.toBeNull();
    expect(after!.available).toBe(0);
    expect(after!.reserved).toBe(0);
  });

  it('does NOT throw when days === 0 on an autocreated zero balance', async () => {
    // 0 days requested against 0 available is valid (0 - 0 = 0 >= 0)
    await expect(
      balanceSvc.validateAvailability('emp1', 'loc1', 0),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveWithRetry — OptimisticLockVersionMismatchError recovery (lines 108-132)
// ---------------------------------------------------------------------------

describe('BalanceService.saveWithRetry — recovers from OptimisticLockVersionMismatchError', () => {
  const { builder } = createTestModule();
  let moduleRef: TestingModule;
  let balanceSvc: BalanceService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    moduleRef = await builder.compile();
    await moduleRef.init();
    balanceSvc = moduleRef.get(BalanceService);
    balanceRepo = moduleRef.get(getRepositoryToken(Balance));
  });

  afterEach(() => moduleRef.close());

  it('retries once on OptimisticLockVersionMismatchError and eventually succeeds', async () => {
    // Seed a balance row
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });

    // Spy on balanceRepo.save: throw the optimistic-lock error once, then delegate to real impl.
    const originalSave = balanceRepo.save.bind(balanceRepo);
    let callCount = 0;
    const saveSpy = jest
      .spyOn(balanceRepo, 'save')
      .mockImplementation(async (...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          throw new OptimisticLockVersionMismatchError('Balance', 1, 2);
        }
        // Delegate to the real save on retry
        return originalSave(...args);
      });

    // reserve() exercises saveWithRetry internally
    await expect(
      balanceSvc.reserve('emp1', 'loc1', 3),
    ).resolves.toBeUndefined();

    // save was called at least twice (once failed, once succeeded)
    expect(saveSpy).toHaveBeenCalledTimes(2);

    // The mutation was eventually applied
    const row = await getRow(balanceRepo);
    expect(row!.reserved).toBe(3);

    saveSpy.mockRestore();
  });

  it('propagates the error when all retry attempts are exhausted', async () => {
    await seedBalance(balanceRepo, { available: 10, reserved: 0 });

    // Always throw OptimisticLockVersionMismatchError
    const saveSpy = jest
      .spyOn(balanceRepo, 'save')
      .mockRejectedValue(
        new OptimisticLockVersionMismatchError('Balance', 1, 99),
      );

    // MAX_OPTIMISTIC_RETRIES = 5 → attempt + retry loop = 6 saves total before giving up
    await expect(balanceSvc.reserve('emp1', 'loc1', 1)).rejects.toBeInstanceOf(
      OptimisticLockVersionMismatchError,
    );

    saveSpy.mockRestore();
  });
});
