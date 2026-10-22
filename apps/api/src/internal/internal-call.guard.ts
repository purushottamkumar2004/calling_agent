import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { errors } from '../common/errors';
import { getContext } from '../common/request-context';
import { zUuid } from '../common/validation';
import { DbService } from '../db/db.service';

/**
 * Contract rule 2: every call-scoped request carries X-Tenant-Id and X-Call-Id, and the
 * Core API rejects a request whose tenant does not own the call. Runs after ServiceAuthGuard.
 */
@Injectable()
export class InternalCallGuard implements CanActivate {
  private readonly logger = new Logger(InternalCallGuard.name);

  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const tenantId = header(req, 'x-tenant-id');
    const callId = header(req, 'x-call-id');
    if (!tenantId || !zUuid.safeParse(tenantId).success) {
      throw errors.validation('X-Tenant-Id header must be a UUID');
    }
    if (!callId || !zUuid.safeParse(callId).success) {
      throw errors.validation('X-Call-Id header must be a UUID');
    }

    const ctx = getContext();
    if (ctx) {
      ctx.tenantId = tenantId;
      ctx.callId = callId;
    }

    const owner = await this.db.systemTx(async (tx) => {
      const { rows } = await tx.query<{ owner: string | null }>('SELECT resource_tenant($1, $2) AS owner', [
        'call',
        callId,
      ]);
      return rows[0]?.owner ?? null;
    });
    if (owner !== tenantId) {
      // Unknown call and another tenant's call are reported identically: no existence oracle,
      // and the Voice Worker's safe behaviour (fail call, transfer) is right for both.
      this.logger.warn({ call_owner_known: owner !== null }, 'call not owned by tenant');
      throw errors.tenantMismatch('Call is not owned by this tenant');
    }
    return true;
  }
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
