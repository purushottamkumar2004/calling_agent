import { Injectable } from '@nestjs/common';
import { FieldCrypto } from '../crypto/field-crypto';
import type { Tx } from '../db/db.service';
import { SchedulingRepository } from './scheduling.repository';

export type Language = 'en-IN' | 'hi-IN';

export interface ContactInfo {
  id: string;
  phone: string;
  name: string | null;
  language: Language | null;
  consentWhatsapp: boolean;
}

export type ContactRef = { contact_id: string } | { phone: string; name?: string; language?: Language };

interface ContactRow {
  id: string;
  phone_ciphertext: string;
  name: string | null;
  language: Language | null;
  consent_whatsapp: boolean;
}

@Injectable()
export class ContactsRepository {
  constructor(
    private readonly crypto: FieldCrypto,
    private readonly scheduling: SchedulingRepository,
  ) {}

  /**
   * Existing contact by id, or find-or-create by phone. A known contact keeps its stored
   * name (staff edits win over what a caller says); a stated language updates it.
   */
  async resolve(tx: Tx, ref: ContactRef): Promise<ContactInfo> {
    if ('contact_id' in ref) {
      const { rows } = await tx.query<ContactRow>(
        'SELECT id, phone_ciphertext, name, language, consent_whatsapp FROM contacts WHERE id = $1',
        [ref.contact_id],
      );
      const row = rows[0];
      if (!row) return this.scheduling.missing(tx, 'contact', ref.contact_id, 'Contact');
      return this.toInfo(row);
    }

    const { rows } = await tx.query<ContactRow>(
      `INSERT INTO contacts (tenant_id, phone_ciphertext, phone_hash, name, language)
       VALUES (app_current_tenant(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, phone_hash) DO UPDATE SET
         name = COALESCE(contacts.name, EXCLUDED.name),
         language = COALESCE(EXCLUDED.language, contacts.language)
       RETURNING id, phone_ciphertext, name, language, consent_whatsapp`,
      [this.crypto.encrypt(ref.phone), this.crypto.phoneHash(ref.phone), ref.name ?? null, ref.language ?? null],
    );
    return this.toInfo(rows[0] as ContactRow);
  }

  async exists(tx: Tx, contactId: string): Promise<boolean> {
    const { rowCount } = await tx.query('SELECT 1 FROM contacts WHERE id = $1', [contactId]);
    return rowCount === 1;
  }

  private toInfo(row: ContactRow): ContactInfo {
    return {
      id: row.id,
      phone: this.crypto.decrypt(row.phone_ciphertext),
      name: row.name,
      language: row.language,
      consentWhatsapp: row.consent_whatsapp,
    };
  }
}
