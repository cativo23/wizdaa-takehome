import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReconciliationService } from './reconciliation.service';
import { BatchController } from './batch.controller';
import { BatchSyncLog } from '../entities/batch-sync-log.entity';
import { ReconciliationEvent } from '../entities/reconciliation-event.entity';
import { BalanceModule } from '../balance/balance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BatchSyncLog, ReconciliationEvent]),
    BalanceModule,
  ],
  controllers: [BatchController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
