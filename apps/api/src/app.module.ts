import { type DynamicModule, Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ServiceAuthGuard, UserAuthGuard } from './auth/guards';
import { JwtService } from './auth/jwt';
import { ErrorFilter } from './common/error.filter';
import { loggerParams } from './common/logging';
import { APP_CONFIG, type AppConfig } from './config/env';
import { FieldCrypto } from './crypto/field-crypto';
import { DashboardAppointmentsController, DashboardSlotsController } from './dashboard/dashboard-scheduling.controller';
import { DbModule } from './db/db.module';
import { OutboxRelayService, REDIS } from './events/outbox-relay.service';
import { HealthController } from './health/health.controller';
import { IdempotencyService } from './idempotency/idempotency.service';
import { InternalCallGuard } from './internal/internal-call.guard';
import { InternalSchedulingController } from './internal/internal-scheduling.controller';
import { AppointmentsService } from './scheduling/appointments.service';
import { AvailabilityService } from './scheduling/availability.service';
import { ContactsRepository } from './scheduling/contacts.repository';
import { SchedulingRepository } from './scheduling/scheduling.repository';
import { SlotsAdminService } from './scheduling/slots-admin.service';

/** Closes the shared Redis client after everything else has shut down. */
@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logStream?: DestinationStream): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerParams(config, logStream)),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
        DbModule,
      ],
      controllers: [
        HealthController,
        AuthController,
        InternalSchedulingController,
        DashboardSlotsController,
        DashboardAppointmentsController,
      ],
      providers: [
        { provide: APP_FILTER, useClass: ErrorFilter },
        {
          provide: REDIS,
          useFactory: () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true }),
        },
        RedisShutdown,
        JwtService,
        FieldCrypto,
        AuthService,
        UserAuthGuard,
        ServiceAuthGuard,
        InternalCallGuard,
        IdempotencyService,
        SchedulingRepository,
        ContactsRepository,
        AvailabilityService,
        AppointmentsService,
        SlotsAdminService,
        OutboxRelayService,
      ],
    };
  }
}
