/**
 * This is an integration test that wires the REAL HcmClientService (not the
 * FakeHcmClient harness override) to a controlled HTTP stub. It exists
 * specifically to catch user-facing latency regressions on the read-path HCM
 * calls — a class of bug the rest of the Jest suite cannot see because it
 * mocks the seam. Added after the e2e curl smoke (`scripts/e2e-smoke.sh`)
 * surfaced 31-second hangs on cold-read + HCM-down. See ADR-001/ADR-014 for
 * the design contract; see git log for the fix commit.
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { ClockModule } from '../common/clock/clock.module';
import { LockModule } from '../common/lock/lock.module';
import { BalanceModule } from '../balance/balance.module';
import { TimeOffRequestModule } from '../time-off-request/time-off-request.module';
import { HcmModule } from '../hcm/hcm.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ReservationReaperModule } from '../reservation-reaper/reservation-reaper.module';
import {
  Balance,
  TimeOffRequest,
  Outbox,
  BatchSyncLog,
  ReconciliationEvent,
} from '../entities';
import { buildDataSourceOptions } from '../database/database.module';
import { BalanceService } from '../balance/balance.service';
import { TimeOffRequestService } from '../time-off-request/time-off-request.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestStatus } from '../entities/enums';
import { CLOCK } from '../common/clock/clock.tokens';
import { FakeClock } from '../common/clock/fake-clock';

jest.setTimeout(15000);

// ---------------------------------------------------------------------------
// In-test HTTP stub — simulates a real (but controlled) HCM server
// ---------------------------------------------------------------------------

type StubMode = 'ok' | '503';

let stubMode: StubMode = 'ok';
let stubServer: http.Server;
let stubPort: number;

/** Seed state: employeeId → balance value returned when mode is 'ok' */
const stubBalances = new Map<string, number>();

function startStubServer(): Promise<void> {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      if (stubMode === '503') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
        return;
      }

      // Parse employeeId from query string
      const url = new URL(req.url ?? '/', `http://localhost:${stubPort}`);
      const employeeId = url.searchParams.get('employeeId') ?? 'unknown';
      const locationId = url.searchParams.get('locationId') ?? 'unknown';
      const balance = stubBalances.get(employeeId) ?? 0;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          employeeId,
          locationId,
          balance,
          asOf: new Date().toISOString(),
        }),
      );
    });

    stubServer.listen(0, '127.0.0.1', () => {
      stubPort = (stubServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

function stopStubServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    stubServer.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Stub AppConfigService factory — returns a plain object that satisfies the
// interface without needing ConfigService injected.
// ---------------------------------------------------------------------------

function makeStubConfig(hcmBaseUrl: string): Partial<AppConfigService> {
  return {
    hcmBaseUrl,
    hcmRetryMaxAttempts: 5,
    hcmRetryBackoffMs: 1000,
    reservationTtlDays: 14,
    port: 3000,
    databasePath: ':memory:',
    balanceLazyLoadEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Module builder — wires the REAL HcmClientService (no HCM_CLIENT override).
// We import ConfigModule.forRoot (global) so NestJS internals are satisfied,
// then immediately override AppConfigService with our stub so the service
// under test points at our in-process HTTP stub instead of the real HCM URL.
// ---------------------------------------------------------------------------

async function buildModule(hcmBaseUrl: string) {
  const fakeClock = new FakeClock(new Date('2026-05-27T00:00:00Z'));
  const stubConfig = makeStubConfig(hcmBaseUrl);

  const moduleRef = await Test.createTestingModule({
    imports: [
      // AppConfigModule is @Global() — registers AppConfigService globally so
      // all domain modules can inject it. We immediately override it below
      // with a stub that points hcmBaseUrl at our in-process HTTP stub.
      AppConfigModule,

      TypeOrmModule.forRoot(
        buildDataSourceOptions({
          database: ':memory:',
          synchronize: true,
          dropSchema: true,
        }),
      ),
      TypeOrmModule.forFeature([
        Balance,
        TimeOffRequest,
        Outbox,
        BatchSyncLog,
        ReconciliationEvent,
      ]),

      ClockModule,
      LockModule,
      BalanceModule,
      HcmModule, // <-- REAL HcmClientService, no override
      TimeOffRequestModule,
      ReconciliationModule,
      ReservationReaperModule,
    ],
  })
    .overrideProvider(AppConfigService)
    .useValue(stubConfig)
    .overrideProvider(CLOCK)
    .useValue(fakeClock)
    .compile();

  await moduleRef.init();
  return moduleRef;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('HcmClientService real-integration — read-path fast-fail', () => {
  beforeAll(async () => {
    await startStubServer();
  });

  afterAll(async () => {
    await stopStubServer();
  });

  beforeEach(() => {
    stubBalances.clear();
    stubMode = 'ok';
  });

  // -------------------------------------------------------------------------
  // Test (a): lazy-hydrate cold-read fails fast (≤ 3.5s) when HCM is down
  //
  // Directly exercises S4: GET /balances for a tuple never seen before, with
  // HCM responding 503. Before the fix, BalanceService.getBalance called
  // hcmClient.getBalance without retry:false, which burned the full 31-second
  // exponential backoff budget. With the fix, retry:false → single attempt,
  // 2500 ms per-request timeout → fast HcmUnavailableError → degraded DTO.
  // -------------------------------------------------------------------------
  it('lazy-hydrate cold-read fails fast (≤ 3.5s) when HCM is down', async () => {
    stubMode = '503'; // HCM is down — every request gets a 503

    const moduleRef = await buildModule(`http://127.0.0.1:${stubPort}`);
    const balanceSvc = moduleRef.get(BalanceService);

    const t0 = Date.now();
    const result = await balanceSvc.getBalance('cold_emp', 'loc1');
    const elapsed = Date.now() - t0;

    // Degraded DTO must be returned — not a thrown exception
    expect((result as any).degraded).toBe(true);
    expect(result.available).toBe(0);

    // Must have failed fast — well under 31 s, within the 3.5 s budget
    expect(elapsed).toBeLessThan(3500);

    await moduleRef.close();
  });

  // -------------------------------------------------------------------------
  // Test (b): approve falls through to local cache fast (≤ 3.5s) when HCM is
  // down.
  //
  // Directly exercises S11: approve is called with HCM responding 503. Before
  // the fix, approve burned 31 s on the getBalance call before falling through
  // to PENDING_SYNC. With the fix, retry:false → single fast-fail → falls
  // through to local cache immediately.
  // -------------------------------------------------------------------------
  it('approve falls through to local cache fast (≤ 3.5s) when HCM is down', async () => {
    // HCM is up for the pre-conditions, then goes down for the approve call.
    stubMode = 'ok';
    stubBalances.set('approve_emp', 10);

    const moduleRef = await buildModule(`http://127.0.0.1:${stubPort}`);
    const balanceSvc = moduleRef.get(BalanceService);
    const requestSvc = moduleRef.get(TimeOffRequestService);
    const balanceRepo = moduleRef.get<Repository<Balance>>(
      getRepositoryToken(Balance),
    );

    // Pre-seed a warm balance (lastHcmAsOf set → hot path skips HCM on submit)
    const warmBalance = balanceRepo.create({
      employeeId: 'approve_emp',
      locationId: 'loc1',
      available: 10,
      reserved: 0,
      needsReview: false,
      lastHcmAsOf: new Date('2026-05-26T00:00:00Z'),
    });
    await balanceRepo.save(warmBalance);

    // Submit succeeds while HCM is up
    const submitResult = await requestSvc.submit(
      'approve_emp',
      'loc1',
      '2026-07-01',
      '2026-07-01', // 1 business day (Tuesday)
      'idempotency-key-approve-test-001',
    );
    expect(submitResult.status).toBe(RequestStatus.PENDING);

    // Now take HCM down before the approve call
    stubMode = '503';

    const t0 = Date.now();
    const approveResult = await requestSvc.approve(submitResult.id, 'manager1');
    const elapsed = Date.now() - t0;

    // ADR-001: approve must proceed to PENDING_SYNC (not fail) when HCM is
    // unavailable — the outbox dispatcher will handle the HCM call later.
    expect(approveResult.status).toBe(RequestStatus.PENDING_SYNC);

    // Must have fallen through fast — well under 31 s, within the 3.5 s budget
    expect(elapsed).toBeLessThan(3500);

    await moduleRef.close();
  });
});
