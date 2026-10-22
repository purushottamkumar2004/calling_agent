import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';
import { requireTenantContext } from '../common/request-context';
import { parse } from '../common/validation';
import { AuthService, type TokenPair } from './auth.service';
import { UserAuthGuard } from './guards';

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
const refreshBody = z.object({ refresh_token: z.string().min(10).max(200) });

@Controller('v1/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: unknown): Promise<TokenPair> {
    const { email, password } = parse(loginBody, body);
    return this.auth.login(email, password);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  refresh(@Body() body: unknown): Promise<TokenPair> {
    return this.auth.refresh(parse(refreshBody, body).refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    await this.auth.logout(parse(refreshBody, body).refresh_token);
  }

  @Get('me')
  @UseGuards(UserAuthGuard)
  me(): { tenant_id: string; user_id: string; role: string } {
    const ctx = requireTenantContext();
    if (ctx.actor.type !== 'user') throw new Error('unreachable');
    return { tenant_id: ctx.tenantId, user_id: ctx.actor.userId, role: ctx.actor.role };
  }
}
