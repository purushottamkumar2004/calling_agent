import type { DestinationStream } from 'pino';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config/env';
import type { RequestWithContext } from './context.middleware';
import { getContext, logFields } from './request-context';

/**
 * Structured JSON logs. Every line carries request_id and, once known, tenant_id and
 * call_id (architecture convention). Secrets and phone numbers are redacted.
 */
export function loggerParams(config: AppConfig, stream?: DestinationStream): Params {
  const options = {
    level: config.LOG_LEVEL,
    base: { service: 'core-api' },
    messageKey: 'message',
    mixin: () => logFields(),
    // Request-completion lines may run outside the async context; fall back to req.ctx.
    customProps: (req) => {
      if (getContext()) return {};
      const ctx = (req as RequestWithContext).ctx;
      return ctx
        ? {
            request_id: ctx.requestId,
            ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
            ...(ctx.callId ? { call_id: ctx.callId } : {}),
          }
        : {};
    },
    genReqId: (req) => (req as RequestWithContext).ctx?.requestId ?? 'unknown',
    quietReqLogger: true,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'phone',
        '*.phone',
        'password',
        '*.password',
        'refresh_token',
        '*.refresh_token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ status_code: res.statusCode }),
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    transport:
      config.NODE_ENV === 'development' && !stream ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  } satisfies NonNullable<Params['pinoHttp']>;
  return { pinoHttp: stream ? [options, stream] : options };
}
