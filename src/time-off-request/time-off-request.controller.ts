import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TimeOffRequestService } from './time-off-request.service';
import { SubmitRequestDto } from './dto/submit-request.dto';
import { TimeOffRequest } from '../entities/time-off-request.entity';

/**
 * TimeOffRequestController — thin HTTP boundary for the request lifecycle.
 *
 * Principal injection (upstream gateway, §12/A4):
 *   X-Employee-Id  — trusted employee ID
 *   X-Role         — 'employee' | 'manager'
 *
 * IDOR: employees may only submit/cancel for their own employeeId (§12).
 * Approve/reject are manager-only.
 *
 * `days` is NEVER accepted from the client; it is server-computed in the
 * service from the date range (§12).
 */
@Controller('time-off-requests')
export class TimeOffRequestController {
  constructor(private readonly service: TimeOffRequestService) {}

  /**
   * POST /time-off-requests
   * Submit a time-off request. FR-2/FR-3. ADR-012.
   *
   * The `Idempotency-Key` header carries the client-minted UUID v4 (ADR-012).
   * Required — 422 if absent.
   */
  @Post()
  async submit(
    @Body() body: SubmitRequestDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-employee-id') principalId: string,
    @Headers('x-role') role: string,
  ): Promise<TimeOffRequest> {
    if (!principalId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    // Idempotency-Key is required for submit (ADR-012). Any non-empty string is
    // accepted in v1; UUID-format enforcement can be added later.
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new BadRequestException('Idempotency-Key header is required and must be ≤ 200 chars.');
    }
    if (body.employeeId !== principalId) {
      throw new ForbiddenException(
        'Employees may only submit requests for themselves.',
      );
    }
    return this.service.submit(
      body.employeeId,
      body.locationId,
      body.startDate,
      body.endDate,
      idempotencyKey,
    );
  }

  /**
   * POST /time-off-requests/:id/approve
   * Approve a PENDING request. Manager-only. FR-4/FR-5. ADR-001/ADR-004/ADR-011.
   */
  @Post(':id/approve')
  async approve(
    @Param('id', ParseUUIDPipe) requestId: string,
    @Headers('x-employee-id') managerId: string,
    @Headers('x-role') role: string,
  ): Promise<TimeOffRequest> {
    if (!managerId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    if (role !== 'manager') {
      throw new ForbiddenException('Only managers may approve requests.');
    }
    return this.service.approve(requestId, managerId);
  }

  /**
   * POST /time-off-requests/:id/reject
   * Reject a PENDING or PENDING_SYNC request. Manager-only. FR-4. ADR-002.
   */
  @Post(':id/reject')
  async reject(
    @Param('id', ParseUUIDPipe) requestId: string,
    @Headers('x-employee-id') managerId: string,
    @Headers('x-role') role: string,
    @Body('reason') reason?: string,
  ): Promise<TimeOffRequest> {
    if (!managerId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    if (role !== 'manager') {
      throw new ForbiddenException('Only managers may reject requests.');
    }
    return this.service.reject(requestId, managerId, reason);
  }

  /**
   * POST /time-off-requests/:id/cancel
   * Cancel a PENDING, PENDING_SYNC, or APPROVED request. FR-6. ADR-004/ADR-011.
   * Employees cancel their own; managers may cancel any.
   */
  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) requestId: string,
    @Headers('x-employee-id') principalId: string,
    @Headers('x-role') role: string,
  ): Promise<TimeOffRequest> {
    if (!principalId) {
      throw new BadRequestException('X-Employee-Id header is required.');
    }
    if (role !== 'employee' && role !== 'manager') {
      throw new BadRequestException(
        'X-Role header must be "employee" or "manager".',
      );
    }
    // IDOR (§12): employees may only cancel their own requests; managers may cancel any.
    if (role !== 'manager') {
      const existing = await this.service.findById(requestId);
      if (!existing) {
        throw new NotFoundException(`TimeOffRequest ${requestId} not found`);
      }
      if (existing.employeeId !== principalId) {
        throw new ForbiddenException('Employees may only cancel their own requests.');
      }
    }
    return this.service.cancel(requestId, principalId);
  }
}
