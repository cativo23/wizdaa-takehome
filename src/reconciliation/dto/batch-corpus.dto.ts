import {
  IsNumber,
  IsInt,
  IsPositive,
  IsISO8601,
  IsArray,
  ValidateNested,
  IsString,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Individual balance entry within a batch corpus.
 */
export class HcmBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @IsInt()
  balance!: number;

  @IsISO8601()
  asOf!: string;
}

/**
 * Body for POST /timeoff/hcm/batch — HCM → service push. §8/ADR-009.
 *
 * `sequence` must be monotonically increasing; service rejects batches with
 * sequence <= last applied (ADR-009).
 * `asOf` is the snapshot timestamp used as the replay cutoff in ADR-003.
 */
export class BatchCorpusDto {
  @IsInt()
  @IsPositive()
  sequence!: number;

  @IsISO8601()
  asOf!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HcmBalanceDto)
  balances!: HcmBalanceDto[];
}
