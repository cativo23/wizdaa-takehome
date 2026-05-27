import { IsString, IsNotEmpty, IsDateString, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';

/**
 * Custom validator: endDate must be >= startDate.
 */
@ValidatorConstraint({ name: 'endDateAfterStartDate', async: false })
export class EndDateAfterStartDateConstraint
  implements ValidatorConstraintInterface
{
  validate(endDate: string, args: ValidationArguments): boolean {
    const obj = args.object as SubmitRequestDto;
    if (!obj.startDate || !endDate) return true; // let IsDateString handle nulls
    return endDate >= obj.startDate;
  }

  defaultMessage(): string {
    return 'endDate must be on or after startDate';
  }
}

/**
 * Body for POST /time-off-requests — FR-2.
 *
 * `days` is NOT accepted here — it is always server-computed from the date
 * range and the location calendar (§12). A client-supplied day count is
 * never trusted.
 *
 * The `Idempotency-Key` header is read by the controller, not this DTO.
 */
export class SubmitRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  /** Inclusive start date (YYYY-MM-DD). */
  @IsDateString()
  startDate!: string;

  /** Inclusive end date (YYYY-MM-DD). */
  @IsDateString()
  @Validate(EndDateAfterStartDateConstraint)
  endDate!: string;
}
