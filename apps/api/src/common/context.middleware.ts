import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { type RequestContext, runWithContext } from './request-context';

export type RequestWithContext = Request & { ctx?: RequestContext };

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** First middleware: opens the per-request async context used by guards and loggers. */
export function contextMiddleware(req: RequestWithContext, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  const ctx: RequestContext = { requestId };
  req.ctx = ctx;
  res.setHeader('X-Request-Id', requestId);
  runWithContext(ctx, () => next());
}
