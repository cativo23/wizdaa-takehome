import { IsString, IsNotEmpty } from 'class-validator';

/**
 * Body for PATCH /balances/resolve-review — clears Balance.needsReview (B4).
 *
 * Manager-only. The manager has verified the divergence and determined the
 * current balance is acceptable (or has manually adjusted it).
 */
export class ResolveReviewDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;
}
