import { IsUUID } from 'class-validator';

/**
 * Body for POST /time-off-requests/:id/cancel — FR-6.
 * The request ID comes from the URL param.
 */
export class CancelRequestDto {
  @IsUUID()
  id!: string;
}
