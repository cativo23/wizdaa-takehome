import { Injectable } from '@nestjs/common';
import { HcmClient } from './contracts/hcm-client.interface';
import {
  HcmBalance,
  FileTimeOffCommand,
  FileTimeOffResult,
  ReverseTimeOffCommand,
  ReverseTimeOffResult,
} from './contracts/hcm.types';

/**
 * HcmClientService — production implementation of HcmClient.
 *
 * Bound to the HCM_CLIENT token in HcmModule.
 *
 * Responsibilities (Phase 1 fills the bodies):
 * - HTTP calls to HCM_BASE_URL via @nestjs/axios HttpService.
 * - Retry with exponential backoff up to hcmRetryMaxAttempts (ADR-004).
 * - Pass idempotencyKey as `Idempotency-Key` header (ADR-008).
 * - Never throw on HCM error — return `{ ok: false, errorHint }` (ADR-001).
 * - Structured logging of request/response (no PHI, §12).
 */
@Injectable()
export class HcmClientService implements HcmClient {
  getBalance(_employeeId: string, _locationId: string): Promise<HcmBalance> {
    throw new Error('NotImplemented: HcmClientService.getBalance');
  }

  fileTimeOff(_cmd: FileTimeOffCommand): Promise<FileTimeOffResult> {
    throw new Error('NotImplemented: HcmClientService.fileTimeOff');
  }

  reverseTimeOff(_cmd: ReverseTimeOffCommand): Promise<ReverseTimeOffResult> {
    throw new Error('NotImplemented: HcmClientService.reverseTimeOff');
  }
}
