/**
 * MockHcm — HCM-facing endpoints (§8 interface contract).
 *
 * GET  /hcm/balance         → HcmBalance
 * POST /hcm/timeoff         → FileTimeOffResult   (idempotent via Idempotency-Key)
 * POST /hcm/timeoff/reverse → ReverseTimeOffResult (idempotent via Idempotency-Key)
 *
 * Behavior is governed by the active scenario (ADR-007).
 */

import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  HcmBalance,
  FileTimeOffResult,
  ReverseTimeOffResult,
} from '../hcm/contracts/hcm.types.js';
import {
  balanceStore,
  idempotencyStore,
  storeKey,
  getScenario,
} from './mock-hcm.store.js';
import { FileTimeOffDto, ReverseTimeOffDto } from './dto/file-timeoff.dto.js';

@Controller('hcm')
export class HcmController {
  /**
   * GET /hcm/balance?employeeId=&locationId=
   *
   * Scenarios:
   * - correct              — returns the stored balance.
   * - mutate-between-calls — decrements balance by 1 on each GET (simulates mid-flight change, E10).
   * - timeout              — throws ServiceUnavailableException (fast "network failure").
   * - divergent-batch      — returns balance as-is here; batch emission will report lower.
   * - all others           — behaves correctly.
   */
  @Get('balance')
  getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
  ): HcmBalance {
    if (!employeeId || !locationId) {
      throw new BadRequestException('employeeId and locationId are required');
    }

    const scenario = getScenario();

    if (scenario === 'timeout') {
      throw new ServiceUnavailableException('HCM timeout (mock scenario)');
    }

    const key = storeKey(employeeId, locationId);
    let entry = balanceStore.get(key);

    if (!entry) {
      // Auto-provision a zero-balance entry so the service never gets a hard 404.
      entry = {
        employeeId,
        locationId,
        balance: 0,
        asOf: new Date().toISOString(),
      };
      balanceStore.set(key, entry);
    }

    if (scenario === 'mutate-between-calls') {
      // Decrement on each read to simulate a balance change mid-flight (E10).
      entry.balance = Math.max(0, entry.balance - 1);
      entry.asOf = new Date().toISOString();
    }

    return {
      employeeId: entry.employeeId,
      locationId: entry.locationId,
      balance: entry.balance,
      asOf: entry.asOf,
    };
  }

  /**
   * POST /hcm/timeoff
   * Header: Idempotency-Key (required)
   * Body: FileTimeOffDto (matches FileTimeOffCommand wire shape)
   *
   * Scenarios:
   * - correct              — deduct days; return { ok: true, ackedAt }.
   * - silent-insufficient  — always return { ok: true } even if balance is insufficient,
   *                          without actually deducting (E3 — local guard must still reject).
   * - ignore-idempotency-key — deducts every time even on repeat key (proves local guard holds, A3).
   * - timeout              — fast network failure.
   * - duplicate-delivery   — idempotency dedup still applies (same as correct for the mock).
   * - all others           — correct behavior.
   */
  @Post('timeoff')
  @HttpCode(HttpStatus.OK)
  fileTimeOff(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() cmd: FileTimeOffDto,
  ): FileTimeOffResult {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const scenario = getScenario();

    if (scenario === 'timeout') {
      throw new ServiceUnavailableException('HCM timeout (mock scenario)');
    }

    // Dedup check — skip only in ignore-idempotency-key scenario.
    const shouldDedup = scenario !== 'ignore-idempotency-key';
    if (shouldDedup) {
      const prior = idempotencyStore.get(idempotencyKey);
      if (prior) {
        return { ok: prior.ok, ackedAt: prior.ackedAt };
      }
    }

    if (scenario === 'silent-insufficient') {
      // Return a 200 OK without actually adjusting the balance (E3).
      const ackedAt = new Date().toISOString();
      if (shouldDedup) {
        idempotencyStore.set(idempotencyKey, { ok: true, ackedAt });
      }
      return { ok: true, ackedAt };
    }

    const key = storeKey(cmd.employeeId, cmd.locationId);
    const entry = balanceStore.get(key);

    if (!entry) {
      const stored = { ok: false, ackedAt: '' };
      if (shouldDedup) {
        idempotencyStore.set(idempotencyKey, stored);
      }
      return { ok: false, errorHint: 'Employee/location not found' };
    }

    if (entry.balance < cmd.days) {
      const stored = { ok: false, ackedAt: '' };
      if (shouldDedup) {
        idempotencyStore.set(idempotencyKey, stored);
      }
      return { ok: false, errorHint: 'Insufficient balance' };
    }

    entry.balance -= cmd.days;
    entry.asOf = new Date().toISOString();

    const ackedAt = new Date().toISOString();
    if (shouldDedup) {
      idempotencyStore.set(idempotencyKey, { ok: true, ackedAt });
    }
    return { ok: true, ackedAt };
  }

  /**
   * POST /hcm/timeoff/reverse
   * Header: Idempotency-Key (required)
   * Body: ReverseTimeOffDto (matches ReverseTimeOffCommand wire shape)
   *
   * A reverse with no matching prior file is a no-op ack (ADR-004/ADR-008).
   * Idempotent: repeat with same key returns stored result without re-applying.
   */
  @Post('timeoff/reverse')
  @HttpCode(HttpStatus.OK)
  reverseTimeOff(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() cmd: ReverseTimeOffDto,
  ): ReverseTimeOffResult {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const scenario = getScenario();

    if (scenario === 'timeout') {
      throw new ServiceUnavailableException('HCM timeout (mock scenario)');
    }

    const shouldDedup = scenario !== 'ignore-idempotency-key';

    // Dedup check.
    if (shouldDedup) {
      const prior = idempotencyStore.get(idempotencyKey);
      if (prior) {
        return { ok: prior.ok, ackedAt: prior.ackedAt };
      }
    }

    const key = storeKey(cmd.employeeId, cmd.locationId);
    const entry = balanceStore.get(key);

    const ackedAt = new Date().toISOString();

    if (!entry) {
      // No-op ack — no FILE landed previously, or entry doesn't exist (ADR-004).
      if (shouldDedup) {
        idempotencyStore.set(idempotencyKey, { ok: true, ackedAt });
      }
      return { ok: true, ackedAt };
    }

    // Restore balance.
    entry.balance += cmd.days;
    entry.asOf = new Date().toISOString();

    if (shouldDedup) {
      idempotencyStore.set(idempotencyKey, { ok: true, ackedAt });
    }
    return { ok: true, ackedAt };
  }
}
