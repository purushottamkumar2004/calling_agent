import { AsyncLocalStorage } from 'node:async_hooks';

export type Actor =
  | { type: 'user'; userId: string; role: UserRole }
  | { type: 'service'; service: string }
  | { type: 'system' };

export type UserRole = 'owner' | 'admin' | 'staff';

/** Per-request state. Guards fill tenant/call/actor; loggers read it on every line. */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  callId?: string;
  actor?: Actor;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Context for code that must only run inside an authenticated, tenant-scoped request. */
export function requireTenantContext(): RequestContext & { tenantId: string; actor: Actor } {
  const ctx = storage.getStore();
  if (!ctx?.tenantId || !ctx.actor) {
    throw new Error('Tenant context missing: route is not behind an auth guard');
  }
  return ctx as RequestContext & { tenantId: string; actor: Actor };
}

/** Fields stamped onto every log line (snake_case to match the platform log schema). */
export function logFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out: Record<string, string> = { request_id: ctx.requestId };
  if (ctx.tenantId) out.tenant_id = ctx.tenantId;
  if (ctx.callId) out.call_id = ctx.callId;
  return out;
}
