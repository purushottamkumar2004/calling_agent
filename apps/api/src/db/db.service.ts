import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/env';

/** The only handle repositories get: a client bound to one open transaction. */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK = '40P01';

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS * 5,
      connectionTimeoutMillis: 2000,
      application_name: 'core-api',
    });
    this.pool.on('error', (err) => this.logger.error({ err }, 'idle postgres client error'));
  }

  /**
   * Runs fn in a transaction with RLS bound to tenantId. Every tenant-data access in the
   * service goes through here; with no tenant bound, RLS hides every row.
   */
  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(fn, tenantId);
  }

  /** Transaction with no tenant bound: only SECURITY DEFINER helpers return data. */
  async systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(fn, null);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(fn: (tx: Tx) => Promise<T>, tenantId: string | null): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        // set_config(..., is_local=true) == SET LOCAL: scoped to this transaction only, so a
        // pooled connection can never leak one tenant's binding into another request.
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
