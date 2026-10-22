import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { errors } from '../common/errors';
import type { Tx } from '../db/db.service';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Contract rule 3: every write takes an Idempotency-Key so a retried tool call never
 * double-books.
 *
 * Runs inside the business transaction. The key row is inserted first; a concurrent
 * request with the same key blocks on the primary key until the first transaction ends,
 * then either replays the stored response (first committed) or proceeds (first rolled
 * back). Only successful responses are stored: errors roll the key back with the rest of
 * the transaction, and retrying them re-evaluates (same outcome for SLOT_TAKEN etc.).
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  async run<T>(
    tx: Tx,
    params: { key: string; operation: string; request: unknown },
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(stableStringify(params.request)).digest();

    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (tenant_id, key, operation, request_hash)
       VALUES (app_current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [params.key, params.operation, requestHash],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await tx.query<{
        operation: string;
        request_hash: Buffer;
        response_status: number | null;
        response_body: T | null;
      }>(
        `SELECT operation, request_hash, response_status, response_body
           FROM idempotency_keys WHERE tenant_id = app_current_tenant() AND key = $1`,
        [params.key],
      );
      const existing = rows[0];
      if (!existing || existing.response_status === null || existing.response_body === null) {
        // Cannot happen: the row only becomes visible once its transaction commits with a response.
        throw new Error('idempotency record without response');
      }
      if (existing.operation !== params.operation || !existing.request_hash.equals(requestHash)) {
        throw errors.validation('Idempotency-Key was already used for a different request');
      }
      this.logger.log({ idempotency_key: params.key, operation: params.operation }, 'idempotent replay');
      return { status: existing.response_status, body: existing.response_body, replayed: true };
    }

    const result = await fn();
    await tx.query(
      `UPDATE idempotency_keys SET response_status = $2, response_body = $3
        WHERE tenant_id = app_current_tenant() AND key = $1`,
      [params.key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  }
}

/** JSON with sorted keys so semantically equal bodies hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
