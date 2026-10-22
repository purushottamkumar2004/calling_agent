import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { DbService } from '../db/db.service';

export const REDIS = Symbol('REDIS');

/**
 * Field name of the Redis Stream entry that carries the JSON envelope.
 * NOTE: not specified by docs/contracts; pending Master-chat confirmation.
 */
export const STREAM_FIELD = 'envelope';

/**
 * Relays committed outbox rows to Redis Streams (at-least-once; consumers dedupe on
 * event_id per contract rule 6). Safe to run in every API replica: rows are claimed with
 * FOR UPDATE SKIP LOCKED.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    private readonly db: DbService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_ENABLED) this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Publishes one batch; returns how many events were published. */
  async publishBatch(limit = 100): Promise<number> {
    return this.db.systemTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; event_id: string; stream: string; envelope: unknown }>(
        'SELECT id, event_id, stream, envelope FROM outbox_claim($1)',
        [limit],
      );
      const published: string[] = [];
      for (const row of rows) {
        try {
          await this.redis.xadd(row.stream, '*', STREAM_FIELD, JSON.stringify(row.envelope));
          published.push(row.id);
        } catch (err) {
          // Keep order per stream: stop the batch at the first failure; retried next tick.
          await tx.query('SELECT outbox_mark_failed($1, $2)', [row.id, String(err)]);
          this.logger.error({ err, event_id: row.event_id }, 'outbox publish failed');
          break;
        }
      }
      if (published.length) await tx.query('SELECT outbox_mark_published($1::bigint[])', [published]);
      return published.length;
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.publishBatch()
        .then((n) => this.schedule(n > 0 ? 0 : this.config.OUTBOX_POLL_INTERVAL_MS))
        .catch((err: unknown) => {
          this.logger.error({ err }, 'outbox relay tick failed');
          this.schedule(this.config.OUTBOX_POLL_INTERVAL_MS * 4);
        });
    }, delayMs);
  }
}
