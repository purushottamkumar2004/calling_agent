import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Field-level encryption for phone numbers (architecture: "Phone encrypted").
 * Ciphertext format: "<key_id>:<base64(iv | tag | ciphertext)>", AES-256-GCM.
 * The key id prefix allows rotation: add the new key, re-encrypt, retire the old one.
 * Lookups use a keyed HMAC so the plaintext never needs to be indexed.
 */
@Injectable()
export class FieldCrypto {
  private readonly keyId: string;
  private readonly key: Buffer;
  private readonly hashKey: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'FIELD_ENCRYPTION_KEY_ID' | 'FIELD_ENCRYPTION_KEY' | 'PHONE_HASH_KEY'>,
  ) {
    this.keyId = config.FIELD_ENCRYPTION_KEY_ID;
    this.key = Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64');
    this.hashKey = Buffer.from(config.PHONE_HASH_KEY, 'base64');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${this.keyId}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(stored: string): string {
    const sep = stored.indexOf(':');
    const keyId = stored.slice(0, sep);
    if (sep < 1 || keyId !== this.keyId) {
      throw new Error(`Unknown field encryption key id "${keyId}"`);
    }
    const raw = Buffer.from(stored.slice(sep + 1), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  /** Deterministic lookup hash for an E.164 phone number. */
  phoneHash(e164: string): Buffer {
    return createHmac('sha256', this.hashKey).update(e164).digest();
  }
}
