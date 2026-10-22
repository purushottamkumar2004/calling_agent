import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { DbService } from '../db/db.service';
import { REDIS } from '../events/outbox-relay.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await Promise.all([this.db.ping(), this.redis.ping()]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
