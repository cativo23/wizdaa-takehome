/**
 * Clock — injectable time abstraction (§9.1, §10).
 *
 * All "now" calls in domain code must go through this interface so that
 * tests can control time deterministically (TTL expiry, past-date checks,
 * DST edge cases — E15/E18).
 *
 * DI token: CLOCK (string token defined in clock.tokens.ts).
 */
export interface Clock {
  now(): Date;
}
