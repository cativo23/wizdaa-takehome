import {
  Controller,
  Get,
  Patch,
  Query,
  Body,
  Headers,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { BalanceService } from './balance.service';
import { GetBalanceDto } from './dto/get-balance.dto';
import { ResolveReviewDto } from './dto/resolve-review.dto';
import { Balance } from '../entities/balance.entity';

/** Balance shape that may carry the ephemeral ADR-014 degraded flag. */
type BalanceResponse = Balance & { degraded?: boolean };

/**
 * BalanceController — thin HTTP boundary for balance operations.
 *
 * The authenticated principal is injected by the upstream gateway as
 * request headers (§12 / A4):
 *   X-Employee-Id   — the requesting employee's ID (trusted)
 *   X-Role          — 'employee' | 'manager' (trusted)
 *
 * IDOR prevention: an employee may only read their own balance (§12).
 * Manager-only: PATCH /balances/resolve-review.
 */
@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  /**
   * GET /balances?employeeId=&locationId=
   * Return current available + reserved balance. FR-1.
   *
   * Authorization: employee may only query their own employeeId; manager may query any.
   */
  @Get()
  async getBalance(
    @Query() query: GetBalanceDto,
    @Headers('x-employee-id') principalId: string,
    @Headers('x-role') role: string,
  ): Promise<BalanceResponse> {
    if (!principalId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    if (role !== 'manager' && query.employeeId !== principalId) {
      throw new ForbiddenException(
        'Employees may only query their own balance.',
      );
    }
    return this.balanceService.getBalance(query.employeeId, query.locationId);
  }

  /**
   * PATCH /balances/resolve-review
   * Clear Balance.needsReview after manager resolution. Manager-only. B4 / ADR-003.
   */
  @Patch('resolve-review')
  async resolveReview(
    @Body() body: ResolveReviewDto,
    @Headers('x-employee-id') principalId: string,
    @Headers('x-role') role: string,
  ): Promise<{ ok: boolean }> {
    if (!principalId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    if (role !== 'manager') {
      throw new ForbiddenException('Only managers may resolve balance reviews.');
    }
    await this.balanceService.resolveReview(body.employeeId, body.locationId);
    return { ok: true };
  }
}
