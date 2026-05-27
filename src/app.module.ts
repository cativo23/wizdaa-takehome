import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ClockModule } from './common/clock/clock.module';
import { LockModule } from './common/lock/lock.module';
import { HcmModule } from './hcm/hcm.module';
import { BalanceModule } from './balance/balance.module';
import { TimeOffRequestModule } from './time-off-request/time-off-request.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReservationReaperModule } from './reservation-reaper/reservation-reaper.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    // Infrastructure — global singletons
    AppConfigModule,
    DatabaseModule,
    ClockModule,
    LockModule,
    ScheduleModule.forRoot(),

    // Domain modules
    HcmModule,
    BalanceModule,
    TimeOffRequestModule,
    ReconciliationModule,
    ReservationReaperModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
