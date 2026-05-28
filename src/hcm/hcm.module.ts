import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmClientService } from './hcm-client.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { HCM_CLIENT } from './hcm.tokens';
import { Outbox } from '../entities/outbox.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Balance } from '../entities/balance.entity';
import { BalanceModule } from '../balance/balance.module';

/**
 * HcmModule — bundles the HCM client and the outbox dispatcher.
 *
 * Exports HCM_CLIENT so other modules (BalanceModule for the approve-time
 * realtime GET) can inject it without knowing the concrete class.
 *
 * Imports BalanceModule so BalanceService is resolvable by the dispatcher.
 * TypeOrmModule.forFeature registers the Outbox and TimeOffRequest repositories
 * needed by OutboxDispatcherService, plus Balance for BalanceService wiring.
 */
@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([Outbox, TimeOffRequest, Balance]),
    BalanceModule,
  ],
  providers: [
    {
      provide: HCM_CLIENT,
      useClass: HcmClientService,
    },
    OutboxDispatcherService,
  ],
  exports: [HCM_CLIENT, OutboxDispatcherService],
})
export class HcmModule {}
