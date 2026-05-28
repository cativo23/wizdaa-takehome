import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import {
  Balance,
  TimeOffRequest,
  Outbox,
  BatchSyncLog,
  ReconciliationEvent,
} from '../entities';

/**
 * Build TypeORM DataSourceOptions from the config service plus optional test
 * overrides. Test harnesses should call this with `{ database: ':memory:',
 * synchronize: true, dropSchema: true }` to get a fresh in-memory DB per run.
 */
export function buildDataSourceOptions(
  overrides: Partial<DataSourceOptions> = {},
): DataSourceOptions {
  const entities = [
    Balance,
    TimeOffRequest,
    Outbox,
    BatchSyncLog,
    ReconciliationEvent,
  ];

  return {
    type: 'better-sqlite3',
    database: '/app/data/timeoff.sqlite',
    entities,
    // Tests override this to true alongside `:memory:` + dropSchema. For the
    // default value here we keep false so the test harness signature is
    // explicit, but the production factory call below sets synchronize: true
    // (acceptable for the take-home single-writer SQLite topology per §11).
    // Production-hardening path: replace with TypeORM migration files and set
    // migrationsRun: true (§11 fork).
    synchronize: false,
    logging: false,
    ...overrides,
  } as DataSourceOptions;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService): DataSourceOptions =>
        // synchronize: true is intentional for the take-home topology (single
        // writer, SQLite). It auto-creates the schema on boot so the service
        // starts clean without migration files. The production-hardening path
        // is to remove this flag and ship TypeORM migrations instead (§11 fork).
        buildDataSourceOptions({
          database: cfg.databasePath,
          synchronize: true,
        }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
