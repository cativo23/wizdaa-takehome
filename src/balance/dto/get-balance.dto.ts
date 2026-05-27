import { IsString, IsNotEmpty } from 'class-validator';

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
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;
}
