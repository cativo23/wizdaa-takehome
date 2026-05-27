import { IsUUID } from 'class-validator';

/**
 * Body for POST /time-off-requests/:id/approve — FR-4/FR-5.
 * The request ID comes from the URL param; no body fields needed.
 * Defined as DTO to satisfy the validation pipeline shape requirements.
 */
export class ApproveRequestDto {
  @IsUUID()
  id!: string;
}
