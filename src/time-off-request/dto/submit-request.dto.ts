import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/** YYYY-MM-DD with valid month/day ranges (still admits Feb 30 etc — round-trip check below). */
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Max calendar days between startDate and endDate (inclusive). Prevents CPU-DoS on the day loop. */
export const MAX_REQUEST_RANGE_DAYS = 365;

/**
 * Custom validator: date string must be a real calendar date (rejects Feb 30 etc.)
 * by round-tripping through Date: new Date('2028-02-30T00:00:00Z').toISOString().slice(0,10) !== '2028-02-30'.
 */
@ValidatorConstraint({ name: 'realCalendarDate', async: false })
export class RealCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    if (!DATE_PATTERN.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return d.toISOString().slice(0, 10) === value;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a real calendar date in YYYY-MM-DD format`;
  }
}

/**
 * Custom validator: endDate must be >= startDate AND the range must not exceed MAX_REQUEST_RANGE_DAYS.
 */
@ValidatorConstraint({ name: 'endDateAfterStartDate', async: false })
export class EndDateAfterStartDateConstraint implements ValidatorConstraintInterface {
  validate(endDate: string, args: ValidationArguments): boolean {
    const obj = args.object as SubmitRequestDto;
    if (!obj.startDate || !endDate) return true;
    if (endDate < obj.startDate) return false;
    const start = new Date(`${obj.startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const rangeDays = (end.getTime() - start.getTime()) / 86_400_000 + 1;
    return rangeDays <= MAX_REQUEST_RANGE_DAYS;
  }

  defaultMessage(): string {
    return `endDate must be on or after startDate and the range must not exceed ${MAX_REQUEST_RANGE_DAYS} calendar days`;
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
  @MaxLength(128)
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  locationId!: string;

  /** Inclusive start date (YYYY-MM-DD). */
  @Matches(DATE_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  @Validate(RealCalendarDateConstraint)
  startDate!: string;

  /** Inclusive end date (YYYY-MM-DD). */
  @Matches(DATE_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  @Validate(RealCalendarDateConstraint)
  @Validate(EndDateAfterStartDateConstraint)
  endDate!: string;
}
