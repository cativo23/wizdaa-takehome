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
        buildDataSourceOptions({ database: cfg.databasePath }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
