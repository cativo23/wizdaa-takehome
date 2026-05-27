import { Injectable } from '@nestjs/common';
import { Clock } from './clock.interface';

/**
 * Production Clock implementation — delegates to `new Date()`.
 * Bound to the CLOCK token by ClockModule and registered globally.
 */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
