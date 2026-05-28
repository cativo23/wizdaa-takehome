import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FakeClock } from '../../src/common/clock/fake-clock';
import { FakeHcmClient } from '../../src/testing/fake-hcm-client';
import { CLOCK } from '../../src/common/clock/clock.tokens';
import { HCM_CLIENT } from '../../src/hcm/hcm.tokens';
import { buildDataSourceOptions } from '../../src/database/database.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { AppConfigModule } from '../../src/config/config.module';
import { ClockModule } from '../../src/common/clock/clock.module';
import { LockModule } from '../../src/common/lock/lock.module';
import { BalanceModule } from '../../src/balance/balance.module';
import { HcmModule } from '../../src/hcm/hcm.module';
import { TimeOffRequestModule } from '../../src/time-off-request/time-off-request.module';
import { ReconciliationModule } from '../../src/reconciliation/reconciliation.module';
import { ReservationReaperModule } from '../../src/reservation-reaper/reservation-reaper.module';
import { HealthController } from '../../src/health/health.controller';
import {
  Balance,
  TimeOffRequest,
  Outbox,
  BatchSyncLog,
  ReconciliationEvent,
} from '../../src/entities';

export interface BootstrapOptions {
  /** When provided, overrides AppConfigService.hcmBaseUrl for real-HCM specs.
   *  When omitted, the HCM_CLIENT token is overridden with a FakeHcmClient. */
  hcmBaseUrl?: string;
  /** Override HCM retry settings when using the real HcmClientService. */
  hcmRetryMaxAttempts?: number;
  hcmRetryBackoffMs?: number;
  /** When true, app.listen(0) is called so the SUT is reachable from the outside
   *  (needed for the emit-batch test in hcm-network.e2e-spec.ts). */
  listen?: boolean;
}

export interface TestAppHandles {
  app: INestApplication;
  moduleRef: TestingModule;
  fakeClock: FakeClock;
  fakeHcm: FakeHcmClient | null;
}

const DEFAULT_CLOCK_DATE = new Date('2026-05-27T00:00:00Z');

export async function bootstrapTestApp(opts: BootstrapOptions = {}): Promise<TestAppHandles> {
  const fakeClock = new FakeClock(DEFAULT_CLOCK_DATE);
  const fakeHcm = opts.hcmBaseUrl ? null : new FakeHcmClient();

  const appConfigStub = {
    databasePath: ':memory:',
    hcmBaseUrl: opts.hcmBaseUrl ?? 'http://localhost:3001',
    reservationTtlDays: 14,
    hcmRetryMaxAttempts: opts.hcmRetryMaxAttempts ?? (opts.hcmBaseUrl ? 3 : 5),
    hcmRetryBackoffMs: opts.hcmRetryBackoffMs ?? (opts.hcmBaseUrl ? 200 : 1000),
    port: 0,
    balanceLazyLoadEnabled: true,
  };

  let builder = Test.createTestingModule({
    imports: [
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
      // NOTE: ScheduleModule.forRoot() is intentionally absent — @Cron/@Interval stay dormant
      AppConfigModule,
      ClockModule,
      LockModule,
      BalanceModule,
      HcmModule,
      TimeOffRequestModule,
      ReconciliationModule,
      ReservationReaperModule,
    ],
    controllers: [HealthController],
  });

  builder = builder
    .overrideProvider(AppConfigService)
    .useValue(appConfigStub)
    .overrideProvider(CLOCK)
    .useValue(fakeClock);

  if (fakeHcm) {
    builder = builder.overrideProvider(HCM_CLIENT).useValue(fakeHcm);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();

  // Must match src/main.ts exactly — R4
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );

  if (opts.listen) {
    await app.listen(0);
  } else {
    await app.init();
  }

  return { app, moduleRef, fakeClock, fakeHcm };
}
