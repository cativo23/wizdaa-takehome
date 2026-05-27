import { Module, Global } from '@nestjs/common';
import { BalanceLockService } from './balance-lock.service';

/**
 * Global LockModule — provides BalanceLockService as a singleton.
 *
 * It MUST be a singleton (one Map for all chains) so that all five actors
 * (approve, retry worker, reconciliation, outbox dispatcher, reservation reaper)
 * share the same in-process chain registry (ADR-010).
 */
@Global()
@Module({
  providers: [BalanceLockService],
  exports: [BalanceLockService],
})
export class LockModule {}
