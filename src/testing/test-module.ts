/**
 * createTestModule — factory for a NestJS testing module that is:
 *
 *   1. Wired with an in-memory SQLite database (fresh per test run).
 *   2. CLOCK overridden with a FakeClock (default: 2026-05-27T00:00:00Z).
 *   3. HCM_CLIENT overridden with a FakeHcmClient.
 *   4. ScheduleModule NOT imported — @Cron/@Interval hooks stay dormant.
 *      Drive the dispatcher and reaper manually via runDispatcherOnce /
 *      runReaperOnce from concurrency-helpers.ts.
 *
 * Usage:
 *
 *   const { moduleRef, clock, hcm } = await createTestModule().compile();
 *   await moduleRef.init();
 *   // ... your test ...
 *   await moduleRef.close();
 *
 * Pass an `overrides` array to swap additional providers:
 *
 *   const { moduleRef } = await createTestModule([
 *     { token: MY_TOKEN, useValue: myStub },
 *   ]).compile();
 */

import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FakeClock } from '../common/clock/fake-clock';
import { CLOCK } from '../common/clock/clock.tokens';
import { HCM_CLIENT } from '../hcm/hcm.tokens';
import { buildDataSourceOptions } from '../database/database.module';
import { AppConfigModule } from '../config/config.module';
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
import { FakeHcmClient } from './fake-hcm-client';

export interface ProviderOverride {
  token: string | symbol;
  useValue: unknown;
}

export interface TestModuleHandles {
  /** The compiled-and-ready builder. Call .compile() then .init() in your test. */
  builder: TestingModuleBuilder;
  /** The FakeClock bound to the CLOCK token — advance time freely. */
  clock: FakeClock;
  /** The FakeHcmClient bound to HCM_CLIENT — seed balances, set scenarios. */
  hcm: FakeHcmClient;
}

const DEFAULT_CLOCK_DATE = new Date('2026-05-27T00:00:00Z');

/**
 * Build a TestingModuleBuilder pre-configured for integration tests.
 *
 * @param overrides  Optional additional provider overrides applied on top of
 *                   the default CLOCK + HCM_CLIENT replacements.
 */
export function createTestModule(
  overrides: ProviderOverride[] = [],
): TestModuleHandles {
  const clock = new FakeClock(DEFAULT_CLOCK_DATE);
  const hcm = new FakeHcmClient();

  let builder = Test.createTestingModule({
    imports: [
      // --- Infrastructure ---
      // Fresh in-memory SQLite per test. synchronize: true creates the schema
      // automatically; dropSchema: true ensures isolation between test runs.
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

      // Global modules (clock + lock must be global to satisfy all injection sites)
      AppConfigModule,
      ClockModule,
      LockModule,

      // Domain modules
      // NOTE: ScheduleModule.forRoot() is intentionally ABSENT.
      //       @Cron and @Interval decorators only fire when ScheduleModule is
      //       imported; without it, the dispatcher and reaper are dormant and
      //       tests drive them manually (see concurrency-helpers.ts).
      BalanceModule,
      HcmModule,
      TimeOffRequestModule,
      ReconciliationModule,
      ReservationReaperModule,
    ],
  });

  // Apply default overrides
  builder = builder
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(HCM_CLIENT)
    .useValue(hcm);

  // Apply caller-supplied overrides
  for (const override of overrides) {
    builder = builder
      .overrideProvider(override.token)
      .useValue(override.useValue);
  }

  return { builder, clock, hcm };
}
