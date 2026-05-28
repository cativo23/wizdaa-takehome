/**
 * src/testing — test harness barrel.
 *
 * Import everything the test suite needs from a single path:
 *
 *   import {
 *     createTestModule,
 *     FakeHcmClient,
 *     seedBalance,
 *     seedRequest,
 *     seedOutbox,
 *     seedBatchSyncLog,
 *     seedReconciliationEvent,
 *     withLockLatch,
 *     runDispatcherOnce,
 *     runReaperOnce,
 *   } from '../testing';
 */

// Module factory + handles
export { createTestModule } from './test-module';
export type { TestModuleHandles, ProviderOverride } from './test-module';

// FakeHcmClient + scenario type
export { FakeHcmClient } from './fake-hcm-client';
export type { HcmScenario, CallCounters } from './fake-hcm-client';

// Seed factories
export {
  seedBalance,
  seedRequest,
  seedOutbox,
  seedBatchSyncLog,
  seedReconciliationEvent,
} from './factories';
export type {
  SeedBalanceOptions,
  SeedRequestOptions,
  SeedOutboxOptions,
  SeedBatchSyncLogOptions,
  SeedReconciliationEventOptions,
} from './factories';

// Concurrency + worker helpers
export {
  withLockLatch,
  runDispatcherOnce,
  runReaperOnce,
} from './concurrency-helpers';
