/**
 * DTOs for Mock HCM control endpoint bodies.
 */

import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsArray,
  IsISO8601,
  IsPositive,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { HcmBalance } from '../../hcm/contracts/hcm.types.js';

const VALID_SCENARIOS = [
  'correct',
  'silent-insufficient',
  'timeout',
  'mutate-between-calls',
  'divergent-batch',
  'duplicate-delivery',
  'ignore-idempotency-key',
] as const;

export class ScenarioDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_SCENARIOS)
  scenario!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsInt()
  balance!: number;
}

/**
 * Concrete class mirroring the HcmBalance wire shape, needed by @ValidateNested.
 * The HcmBalance interface from hcm.types.ts is kept as the field type above but
 * cannot carry decorators, so we declare this parallel class here.
 */
export class HcmBalanceWireDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsInt()
  balance!: number;

  @IsISO8601()
  asOf!: string;
}

export class EmitBatchDto {
  @IsString()
  @IsNotEmpty()
  targetUrl!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HcmBalanceWireDto)
  balances?: HcmBalance[];

  @IsOptional()
  @IsISO8601()
  asOf?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  sequence?: number;
}
