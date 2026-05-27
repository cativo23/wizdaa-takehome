import { IsUUID, IsString, IsOptional } from 'class-validator';

/**
 * Body for POST /time-off-requests/:id/reject — FR-4.
 * The request ID comes from the URL param.
 */
export class RejectRequestDto {
  @IsUUID()
  id!: string;

  /** Optional rejection reason for audit/display. Not logged at info level (§12). */
  @IsString()
  @IsOptional()
  reason?: string;
}
