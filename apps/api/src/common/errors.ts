import type { components } from '../contracts/generated/internal-api';

type ContractErrorCode = components['schemas']['Error']['error']['code'];
export type Slot = components['schemas']['Slot'];

/**
 * Contract codes (docs/contracts/README.md) plus codes used only by the dashboard API.
 * The internal API must only ever return ContractErrorCode.
 */
export type ErrorCode = ContractErrorCode | 'FORBIDDEN' | 'CONFLICT' | 'RATE_LIMITED';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  TENANT_MISMATCH: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SLOT_TAKEN: 409,
  CONFLICT: 409,
  OUTSIDE_HOURS: 422,
  POLICY_BLOCKED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export interface ErrorDetails {
  alternatives?: Slot[];
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: ErrorDetails } } {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const errors = {
  validation: (message: string, details?: ErrorDetails) => new ApiError('VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required') => new ApiError('UNAUTHORIZED', message),
  tenantMismatch: (message = 'Resource is not owned by this tenant') => new ApiError('TENANT_MISMATCH', message),
  forbidden: (message = 'Not allowed for this role') => new ApiError('FORBIDDEN', message),
  notFound: (what: string) => new ApiError('NOT_FOUND', `${what} not found`),
  slotTaken: (alternatives: Slot[]) => new ApiError('SLOT_TAKEN', 'That slot is no longer available', { alternatives }),
  outsideHours: (alternatives: Slot[]) =>
    new ApiError('OUTSIDE_HOURS', 'Requested time is outside clinic hours', { alternatives }),
  policyBlocked: (message: string) => new ApiError('POLICY_BLOCKED', message),
  conflict: (message: string) => new ApiError('CONFLICT', message),
};
