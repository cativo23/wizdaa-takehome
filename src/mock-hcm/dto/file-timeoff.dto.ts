/**
 * DTOs for Mock HCM controller method bodies.
 * Using classes (not interfaces) so emitDecoratorMetadata works with @Body().
 */

import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsDateString,
  Min,
} from 'class-validator';

export class FileTimeOffDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsInt()
  @Min(1)
  days!: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}

export class ReverseTimeOffDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsInt()
  @Min(1)
  days!: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}
