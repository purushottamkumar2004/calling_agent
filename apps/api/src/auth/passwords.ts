import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Verified against when the email is unknown, so response timing does not reveal which
// emails have accounts. Computed once with the same parameters as real hashes.
let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string | undefined, password: string): Promise<boolean> {
  try {
    dummyHash ??= hash('not-a-real-password', OPTIONS);
    return await verify(passwordHash ?? (await dummyHash), password);
  } catch {
    return false;
  }
}
