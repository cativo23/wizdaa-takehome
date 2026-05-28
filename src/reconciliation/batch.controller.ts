import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { BatchCorpusDto } from './dto/batch-corpus.dto';

/**
 * BatchController — receives HCM → service batch corpus pushes. §8/ADR-009.
 *
 * Route: POST /timeoff/hcm/batch
 * This is the inbound endpoint that HCM (or the mock) calls. It is NOT
 * authenticated by the same gateway as employee/manager routes — in a real
 * deployment it would be secured by mutual TLS or a service token from the
 * gateway. This is out of scope for v1 (§12/A4).
 */
@Controller('timeoff/hcm')
export class BatchController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * POST /timeoff/hcm/batch
   * Accept a full balance corpus from HCM. Returns 202 Accepted.
   *
   * Delegates sequencing and reconciliation to ReconciliationService.
   * Stale or out-of-order batches are logged and silently accepted (no error
   * to caller) — the service handles them gracefully (ADR-009).
   */
  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestBatch(
    @Body() body: BatchCorpusDto,
  ): Promise<{ accepted: boolean }> {
    await this.reconciliationService.ingestBatch({
      sequence: body.sequence,
      asOf: body.asOf,
      balances: body.balances.map((b) => ({
        employeeId: b.employeeId,
        locationId: b.locationId,
        balance: b.balance,
        asOf: b.asOf,
      })),
    });
    return { accepted: true };
  }
}
