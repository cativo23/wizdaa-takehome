import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed wrapper around NestJS ConfigService.
 * All environment variables are validated at startup via the Joi schema
 * in config.module.ts — callers can trust these values are defined.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get databasePath(): string {
    return this.config.get<string>('DATABASE_PATH', '/app/data/timeoff.sqlite');
  }

  get hcmBaseUrl(): string {
    return this.config.get<string>('HCM_BASE_URL', 'http://localhost:3001');
  }

  get reservationTtlDays(): number {
    return this.config.get<number>('RESERVATION_TTL_DAYS', 14);
  }

  get hcmRetryMaxAttempts(): number {
    return this.config.get<number>('HCM_RETRY_MAX_ATTEMPTS', 5);
  }

  get hcmRetryBackoffMs(): number {
    return this.config.get<number>('HCM_RETRY_BACKOFF_MS', 1000);
  }

  get port(): number {
    return this.config.get<number>('PORT', 3000);
  }

  /**
   * When true (default), getBalance lazy-hydrates a cold cache from HCM on
   * first access (ADR-014). Set BALANCE_LAZY_LOAD_ENABLED=false to revert to
   * the legacy zero-row-on-miss behaviour for production rollback.
   */
  get balanceLazyLoadEnabled(): boolean {
    const raw = this.config.get<string>('BALANCE_LAZY_LOAD_ENABLED', 'true');
    return raw !== 'false' && raw !== '0';
  }
}
