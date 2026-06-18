import { Controller, Get } from '@nestjs/common';

/** Liveness/health endpoint. */
@Controller()
export class AppController {
  @Get('health')
  health(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'time-off-microservice',
      timestamp: new Date().toISOString(),
    };
  }
}
