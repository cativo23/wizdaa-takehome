import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * HealthController — serves the Docker healthcheck endpoint.
 *
 * The Dockerfile healthcheck calls `wget -qO- http://localhost:{PORT}/`.
 * This controller responds to GET / with HTTP 200 and a status payload.
 */
@Controller()
export class HealthController {
  @Get()
  @HttpCode(HttpStatus.OK)
  health(): { status: string } {
    return { status: 'ok' };
  }
}
