import { type CanActivate, type ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { errors } from '../common/errors';
import { getContext, type UserRole } from '../common/request-context';
import { bearerToken, JwtService, TokenError } from './jwt';

const ROLES_KEY = 'roles';
/** Restricts a dashboard route to the given roles (default: any authenticated user). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Dashboard routes: user access token, binds tenant from the token, enforces @Roles. */
@Injectable()
export class UserAuthGuard implements CanActivate {
  private readonly logger = new Logger(UserAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw errors.unauthorized();

    let claims;
    try {
      claims = await this.jwt.verifyUserAccessToken(token);
    } catch (err) {
      this.logger.warn({ reason: err instanceof TokenError ? err.message : 'unknown' }, 'user token rejected');
      throw errors.unauthorized('Invalid or expired token');
    }

    const ctx = getContext();
    if (ctx) {
      ctx.tenantId = claims.tenantId;
      ctx.actor = { type: 'user', userId: claims.userId, role: claims.role };
    }

    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && !allowed.includes(claims.role)) throw errors.forbidden();
    return true;
  }
}

/** Internal routes: verifies the service JWT only. Tenant binding is InternalCallGuard's job. */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAuthGuard.name);

  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw errors.unauthorized('Service token required');
    try {
      const { service } = await this.jwt.verifyServiceToken(token);
      const ctx = getContext();
      if (ctx) ctx.actor = { type: 'service', service };
      return true;
    } catch (err) {
      this.logger.warn({ reason: err instanceof TokenError ? err.message : 'unknown' }, 'service token rejected');
      throw errors.unauthorized('Invalid service token');
    }
  }
}
