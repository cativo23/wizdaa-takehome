/**
 * DTOs for Mock HCM control endpoint bodies.
 */

import type { HcmBalance } from '../../hcm/contracts/hcm.types.js';

export class ScenarioDto {
  scenario!: string;
}

export class RefreshDto {
  employeeId!: string;
  locationId!: string;
  balance!: number;
}

export class EmitBatchDto {
  targetUrl!: string;
  balances?: HcmBalance[];
  asOf?: string;
  sequence?: number;
}
