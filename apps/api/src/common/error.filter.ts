import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiError } from './errors';

/**
 * Every error leaves the API as {"error": {"code", "message", "details"}} with a stable
 * code (contract rule 5). Unexpected errors are logged with their stack and reported as
 * INTERNAL without leaking internals.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const error = this.toApiError(exception);
    if (error.status >= 500) {
      this.logger.error({ err: exception }, 'unhandled error');
    } else {
      this.logger.log({ error_code: error.code, status: error.status }, error.message);
    }
    if (!res.headersSent) res.status(error.status).json(error.toBody());
  }

  private toApiError(exception: unknown): ApiError {
    if (exception instanceof ApiError) return exception;
    if (exception instanceof ThrottlerException) return new ApiError('RATE_LIMITED', 'Too many requests');
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) return new ApiError('NOT_FOUND', 'Route not found');
      if (status === 413) return new ApiError('VALIDATION_ERROR', 'Request body too large');
      if (status >= 400 && status < 500) return new ApiError('VALIDATION_ERROR', 'Malformed request');
    }
    // body-parser errors (invalid JSON, oversized body) arrive as plain errors with a status.
    if (isClientError(exception)) return new ApiError('VALIDATION_ERROR', 'Malformed request body');
    return new ApiError('INTERNAL', 'Internal server error');
  }
}

function isClientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && 'type' in err;
}
