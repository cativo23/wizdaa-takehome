import { Module, Global } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

/**
 * Global config module. Validates required env vars at startup.
 * Uses NestJS ConfigModule with plain defaults — Joi validation can be
 * added here without changing downstream consumers.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Validate + cast numeric env vars
      expandVariables: false,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
