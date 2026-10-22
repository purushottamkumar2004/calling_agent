import { Inject, Injectable } from '@nestjs/common';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/env';
import type { UserRole } from '../common/request-context';

export const USER_TOKEN_ISSUER = 'core-api';
export const USER_TOKEN_AUDIENCE = 'dashboard';
export const SERVICE_TOKEN_AUDIENCE = 'core-api';

export interface UserClaims {
  userId: string;
  tenantId: string;
  role: UserRole;
}

const ROLES: readonly UserRole[] = ['owner', 'admin', 'staff'];

export class TokenError extends Error {}

@Injectable()
export class JwtService {
  private readonly userKey: Uint8Array;
  private readonly serviceKey: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.userKey = Buffer.from(config.USER_JWT_SECRET, 'base64');
    this.serviceKey = Buffer.from(config.SERVICE_JWT_SECRET, 'base64');
  }

  async signUserAccessToken(claims: UserClaims): Promise<string> {
    return new SignJWT({ tid: claims.tenantId, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(USER_TOKEN_ISSUER)
      .setAudience(USER_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.userKey);
  }

  async verifyUserAccessToken(token: string): Promise<UserClaims> {
    try {
      const { payload } = await jwtVerify(token, this.userKey, {
        algorithms: ['HS256'],
        issuer: USER_TOKEN_ISSUER,
        audience: USER_TOKEN_AUDIENCE,
        requiredClaims: ['sub', 'exp', 'tid', 'role'],
      });
      const role = payload.role as UserRole;
      if (typeof payload.tid !== 'string' || !ROLES.includes(role) || !payload.sub) {
        throw new TokenError('malformed claims');
      }
      return { userId: payload.sub, tenantId: payload.tid, role };
    } catch (err) {
      throw err instanceof TokenError ? err : new TokenError(describe(err));
    }
  }

  /**
   * Service token for /internal/v1. Claims: iss = calling service (allow-listed),
   * aud = "core-api", iat and exp required, lifetime capped by SERVICE_JWT_MAX_TTL_SEC.
   */
  async verifyServiceToken(token: string): Promise<{ service: string }> {
    try {
      const { payload } = await jwtVerify(token, this.serviceKey, {
        algorithms: ['HS256'],
        audience: SERVICE_TOKEN_AUDIENCE,
        requiredClaims: ['iss', 'iat', 'exp'],
        clockTolerance: 5,
      });
      const iss = payload.iss ?? '';
      if (!this.config.SERVICE_JWT_ALLOWED_ISSUERS.includes(iss)) {
        throw new TokenError(`issuer "${iss}" not allowed`);
      }
      if ((payload.exp ?? 0) - (payload.iat ?? 0) > this.config.SERVICE_JWT_MAX_TTL_SEC) {
        throw new TokenError('token lifetime exceeds maximum');
      }
      return { service: iss };
    } catch (err) {
      throw err instanceof TokenError ? err : new TokenError(describe(err));
    }
  }

  /** Test and tooling helper; production services mint their own tokens. */
  async signServiceToken(service: string, ttlSec = 60): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(service)
      .setAudience(SERVICE_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.serviceKey);
  }
}

function describe(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token expired';
  if (err instanceof joseErrors.JOSEError) return err.code;
  return 'invalid token';
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
