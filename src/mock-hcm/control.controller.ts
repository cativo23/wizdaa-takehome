/**
 * MockHcm — Test-harness control endpoints.
 *
 * POST /_control/scenario         — switch active scenario at runtime.
 * POST /_control/refresh          — overwrite a stored balance (simulates year-start / work-anniversary).
 * POST /_control/emit-batch       — build a BatchCorpus and HTTP-POST it to targetUrl.
 * GET  /_control/batch            — return the corpus that would be emitted (tests can fetch-and-post).
 *
 * These endpoints are NEVER imported into the production AppModule (ADR-007 / §12).
 */

import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import type { HcmBalance, BatchCorpus } from '../hcm/contracts/hcm.types.js';
import {
  balanceStore,
  storeKey,
  getScenario,
  setScenario,
  getNextSequence,
  HcmScenario,
} from './mock-hcm.store.js';
import { ScenarioDto, RefreshDto, EmitBatchDto } from './dto/control.dto.js';

const VALID_SCENARIOS: HcmScenario[] = [
  'correct',
  'silent-insufficient',
  'timeout',
  'mutate-between-calls',
  'divergent-batch',
  'duplicate-delivery',
  'ignore-idempotency-key',
];

@Controller('_control')
export class ControlController {
  /**
   * POST /_control/scenario
   * Body: { scenario: HcmScenario }
   *
   * Switches the active scenario. Subsequent calls to /hcm/* will behave accordingly.
   */
  @Post('scenario')
  @HttpCode(HttpStatus.OK)
  setScenario(@Body() body: ScenarioDto): { scenario: string } {
    if (
      !body?.scenario ||
      !VALID_SCENARIOS.includes(body.scenario as HcmScenario)
    ) {
      throw new BadRequestException(
        `Invalid scenario. Valid values: ${VALID_SCENARIOS.join(', ')}`,
      );
    }
    setScenario(body.scenario as HcmScenario);
    return { scenario: body.scenario };
  }

  /**
   * POST /_control/refresh
   * Body: { employeeId, locationId, balance }
   *
   * Overwrites the stored balance with the given value and a fresh `asOf`.
   * Simulates a work-anniversary bonus or year-start refresh (E7 / E10).
   * Makes balance-dropped-mid-flight deterministic for tests.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshDto): HcmBalance {
    if (!body?.employeeId || !body?.locationId) {
      throw new BadRequestException('employeeId and locationId are required');
    }
    if (typeof body.balance !== 'number' || body.balance < 0) {
      throw new BadRequestException('balance must be a non-negative number');
    }

    const key = storeKey(body.employeeId, body.locationId);
    const asOf = new Date().toISOString();
    const entry = {
      employeeId: body.employeeId,
      locationId: body.locationId,
      balance: body.balance,
      asOf,
    };
    balanceStore.set(key, entry);

    return {
      employeeId: body.employeeId,
      locationId: body.locationId,
      balance: body.balance,
      asOf,
    };
  }

  /**
   * GET /_control/batch
   *
   * Returns the BatchCorpus that would be emitted right now (using the NEXT sequence).
   * Does NOT increment the internal sequence counter permanently — use emit-batch for that.
   * Tests can fetch this and POST it to the service's /timeoff/hcm/batch endpoint.
   *
   * In `divergent-batch` scenario, each balance in the corpus is reported 3 lower than stored.
   */
  @Get('batch')
  getBatch(): BatchCorpus {
    return this.buildCorpus();
  }

  /**
   * POST /_control/emit-batch
   * Body: { targetUrl, balances?, asOf?, sequence? }
   *
   * Builds a BatchCorpus (using overrides if provided) and HTTP-POSTs it to targetUrl.
   * Increments the sequence counter (via getNextSequence).
   *
   * This is the "push" path — the mock acts as HCM sending a batch to the service.
   *
   * Returns: { ok: boolean, statusCode: number, corpus: BatchCorpus }
   */
  @Post('emit-batch')
  @HttpCode(HttpStatus.OK)
  async emitBatch(
    @Body() body: EmitBatchDto,
  ): Promise<{ ok: boolean; statusCode: number; corpus: BatchCorpus }> {
    if (!body?.targetUrl) {
      throw new BadRequestException('targetUrl is required');
    }

    const corpus = this.buildCorpus(body.balances, body.asOf, body.sequence);

    try {
      const response = await axios.post(body.targetUrl, corpus, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      return { ok: true, statusCode: response.status, corpus };
    } catch (err: unknown) {
      const status =
        err !== null &&
        typeof err === 'object' &&
        'response' in err &&
        err.response !== null &&
        typeof err.response === 'object' &&
        'status' in err.response
          ? (err.response as { status: number }).status
          : 500;
      return { ok: false, statusCode: status, corpus };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildCorpus(
    balancesOverride?: HcmBalance[],
    asOfOverride?: string,
    sequenceOverride?: number,
  ): BatchCorpus {
    const scenario = getScenario();
    const asOf = asOfOverride ?? new Date().toISOString();
    // If caller explicitly supplies a sequence, use it; otherwise advance the counter.
    const sequence =
      sequenceOverride !== undefined ? sequenceOverride : getNextSequence();

    let balances: HcmBalance[];

    if (balancesOverride) {
      balances = balancesOverride;
    } else {
      balances = Array.from(balanceStore.values()).map((entry) => {
        let reportedBalance = entry.balance;
        if (scenario === 'divergent-batch') {
          // Deliberately report 3 fewer days than stored — corpus disagrees with reality (E6).
          reportedBalance = Math.max(0, entry.balance - 3);
        }
        return {
          employeeId: entry.employeeId,
          locationId: entry.locationId,
          balance: reportedBalance,
          asOf,
        };
      });
    }

    return { sequence, asOf, balances };
  }
}
