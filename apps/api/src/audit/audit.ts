import { getContext } from '../common/request-context';
import type { Tx } from '../db/db.service';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Appends to audit_log inside the caller's transaction; actor and tenant come from context. */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const ctx = getContext();
  const actor = ctx?.actor ?? { type: 'system' as const };
  const actorId = actor.type === 'user' ? actor.userId : actor.type === 'service' ? actor.service : 'system';
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, target_type, target_id, call_id, metadata)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7)`,
    [actor.type, actorId, entry.action, entry.targetType, entry.targetId ?? null, ctx?.callId ?? null, entry.metadata ?? {}],
  );
}
