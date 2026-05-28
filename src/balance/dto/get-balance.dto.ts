import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Query params for GET /balances — FR-1.
 *
 * Both IDs are injected by the upstream gateway (A4); validated here as
 * non-empty strings. IDOR prevention is enforced in the controller against
 * the authenticated employeeId header (§12).
 */
export class GetBalanceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  locationId!: string;
}
