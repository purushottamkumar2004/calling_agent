import { randomBytes } from 'node:crypto';
import { FieldCrypto } from './field-crypto';

const config = {
  FIELD_ENCRYPTION_KEY_ID: 'k1',
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PHONE_HASH_KEY: randomBytes(32).toString('base64'),
};

describe('FieldCrypto', () => {
  const crypto = new FieldCrypto(config);

  it('round-trips and never stores plaintext', () => {
    const stored = crypto.encrypt('+919876543210');
    expect(stored.startsWith('k1:')).toBe(true);
    expect(stored).not.toContain('9876543210');
    expect(crypto.decrypt(stored)).toBe('+919876543210');
  });

  it('uses a fresh IV per encryption', () => {
    expect(crypto.encrypt('+919876543210')).not.toBe(crypto.encrypt('+919876543210'));
  });

  it('detects tampering', () => {
    const stored = crypto.encrypt('+919876543210');
    const raw = Buffer.from(stored.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => crypto.decrypt(`k1:${raw.toString('base64')}`)).toThrow();
  });

  it('rejects unknown key ids', () => {
    expect(() => crypto.decrypt('k9:AAAA')).toThrow(/key id/);
  });

  it('hashes deterministically per key', () => {
    expect(crypto.phoneHash('+919876543210').equals(crypto.phoneHash('+919876543210'))).toBe(true);
    const other = new FieldCrypto({ ...config, PHONE_HASH_KEY: randomBytes(32).toString('base64') });
    expect(other.phoneHash('+919876543210').equals(crypto.phoneHash('+919876543210'))).toBe(false);
  });
});
