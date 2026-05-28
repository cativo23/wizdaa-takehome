import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { Outbox } from '../entities/outbox.entity';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, TimeOffRequest, ReconciliationEvent, Outbox]),
    // forwardRef resolves the BalanceModule ↔ HcmModule circular dependency.
    // HcmModule exports HCM_CLIENT which BalanceService needs for ADR-014
    // lazy hydration; HcmModule imports BalanceModule for OutboxDispatcherService.
    forwardRef(() => HcmModule),
  ],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
