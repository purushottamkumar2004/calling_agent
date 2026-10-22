import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { recordAudit } from '../audit/audit';
import { errors } from '../common/errors';
import { getContext, type UserRole } from '../common/request-context';
import { DbService, type Tx } from '../db/db.service';
import { JwtService } from './jwt';
import { verifyPassword } from './passwords';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

interface AuthUserRow {
  id: string;
  tenant_id: string;
  password_hash: string;
  role: UserRole;
  status: string;
  tenant_status: string;
}

const REFRESH_PREFIX = 'rt_';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.db.systemTx(async (tx) => {
      const { rows } = await tx.query<AuthUserRow>('SELECT * FROM auth_find_user_by_email($1)', [email]);
      return rows[0];
    });

    const passwordOk = await verifyPassword(user?.password_hash, password);
    if (!user || !passwordOk || user.status !== 'active' || user.tenant_status !== 'active') {
      this.logger.warn({ known_user: Boolean(user) }, 'login failed');
      throw errors.unauthorized('Invalid email or password');
    }

    this.bindContext(user.tenant_id, user.id, user.role);
    return this.db.tenantTx(user.tenant_id, async (tx) => {
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await recordAudit(tx, { action: 'auth.login', targetType: 'user', targetId: user.id });
      return this.issue(tx, user.tenant_id, user.id, user.role, null);
    });
  }

  /** Rotating refresh tokens with reuse detection: replaying a used token revokes the family. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.db.systemTx(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        tenant_id: string;
        user_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>('SELECT * FROM auth_find_refresh_token($1)', [tokenHash]);
      return rows[0];
    });
    if (!stored) throw errors.unauthorized('Invalid refresh token');

    return this.db.tenantTx(stored.tenant_id, async (tx) => {
      if (stored.revoked_at) {
        await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
          stored.user_id,
        ]);
        this.logger.warn({ user_id: stored.user_id }, 'refresh token reuse detected; all sessions revoked');
        return null;
      }
      if (stored.expires_at.getTime() <= Date.now()) return null;

      const { rows } = await tx.query<{ role: UserRole; status: string; tenant_status: string }>(
        `SELECT u.role, u.status, t.status AS tenant_status
           FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
        [stored.user_id],
      );
      const user = rows[0];
      if (!user || user.status !== 'active' || user.tenant_status !== 'active') return null;

      this.bindContext(stored.tenant_id, stored.user_id, user.role);
      return this.issue(tx, stored.tenant_id, stored.user_id, user.role, stored.id);
    }).then((pair) => {
      // Throw after commit so a reuse-triggered revocation is persisted.
      if (!pair) throw errors.unauthorized('Invalid refresh token');
      return pair;
    });
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.db.systemTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; tenant_id: string }>(
        'SELECT id, tenant_id FROM auth_find_refresh_token($1)',
        [hashToken(refreshToken)],
      );
      return rows[0];
    });
    if (!stored) return;
    await this.db.tenantTx(stored.tenant_id, (tx) =>
      tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [stored.id]),
    );
  }

  private async issue(
    tx: Tx,
    tenantId: string,
    userId: string,
    role: UserRole,
    replacing: string | null,
  ): Promise<TokenPair> {
    const refreshToken = REFRESH_PREFIX + randomBytes(32).toString('base64url');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
      [tenantId, userId, hashToken(refreshToken), this.config.REFRESH_TOKEN_TTL_SEC],
    );
    if (replacing) {
      await tx.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [
        replacing,
        rows[0]?.id,
      ]);
    }
    const accessToken = await this.jwt.signUserAccessToken({ userId, tenantId, role });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.config.ACCESS_TOKEN_TTL_SEC,
    };
  }

  private bindContext(tenantId: string, userId: string, role: UserRole): void {
    const ctx = getContext();
    if (ctx) {
      ctx.tenantId = tenantId;
      ctx.actor = { type: 'user', userId, role };
    }
  }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
