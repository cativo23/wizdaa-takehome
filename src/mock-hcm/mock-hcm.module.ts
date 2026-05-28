/**
 * MockHcmModule — standalone NestJS module for the Mock HCM server (ADR-007).
 *
 * This module is NEVER imported by AppModule. It has its own bootstrap in main.ts.
 * It exposes the HCM interface contract endpoints plus the _control test-harness endpoints.
 */

import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller.js';
import { ControlController } from './control.controller.js';

@Module({
  controllers: [HcmController, ControlController],
})
export class MockHcmModule {}
