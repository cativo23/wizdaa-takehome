import { Clock } from './clock.interface';

/**
 * FakeClock — test-only time implementation.
 *
 * Usage in a NestJS testing module:
 *
 *   const fakeClock = new FakeClock(new Date('2025-01-01T00:00:00Z'));
 *   const module = await Test.createTestingModule({ ... })
 *     .overrideProvider(CLOCK)
 *     .useValue(fakeClock)
 *     .compile();
 *
 *   // Fast-forward time
 *   fakeClock.advance(15 * 24 * 60 * 60 * 1000); // 15 days
 *   // Or set absolute time
 *   fakeClock.setNow(new Date('2025-01-16T00:00:00Z'));
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date()) {
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Set the clock to an absolute time. */
  setNow(d: Date): void {
    this.current = new Date(d);
  }

  /** Advance the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
