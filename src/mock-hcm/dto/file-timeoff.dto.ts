/**
 * DTOs for Mock HCM controller method bodies.
 * Using classes (not interfaces) so emitDecoratorMetadata works with @Body().
 */

export class FileTimeOffDto {
  employeeId!: string;
  locationId!: string;
  days!: number;
  startDate!: string;
  endDate!: string;
  idempotencyKey!: string;
}

export class ReverseTimeOffDto {
  employeeId!: string;
  locationId!: string;
  days!: number;
  startDate!: string;
  endDate!: string;
  idempotencyKey!: string;
}
