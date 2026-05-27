import { Module, Global } from '@nestjs/common';
import { CLOCK } from './clock.tokens';
import { SystemClock } from './system-clock';

/**
 * Global ClockModule — binds SystemClock to the CLOCK token.
 *
 * Tests override the CLOCK provider in their testing module:
 *   .overrideProvider(CLOCK).useValue(new FakeClock(...))
 */
@Global()
@Module({
  providers: [
    {
      provide: CLOCK,
      useClass: SystemClock,
    },
  ],
  exports: [CLOCK],
})
export class ClockModule {}
