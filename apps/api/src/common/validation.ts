import { z, type ZodTypeAny } from 'zod';
import { errors } from './errors';

/** Parses untrusted input; failures become VALIDATION_ERROR with field-level issues. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw errors.validation(first ? `${first.path || 'request'}: ${first.message}` : 'Invalid request', { issues });
  }
  return result.data;
}

// Shared primitives that mirror docs/contracts (Phone, Language, ids, timestamps).
export const zUuid = z.string().uuid();
export const zPhone = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'must be E.164, e.g. +919876543210');
export const zLanguage = z.enum(['en-IN', 'hi-IN']);
export const zDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));
