import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { Outbox } from '../entities/outbox.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, TimeOffRequest, ReconciliationEvent, Outbox]),
  ],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
