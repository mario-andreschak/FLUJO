import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_PASSWORD, KDF_ITERATIONS } from './format';

const derive = promisify(pbkdf2);
const MAGIC = Buffer.from('FLUJOT01');
const HEADER_BYTES = 8 + 16 + 12 + 4;
const TAG_BYTES = 16;
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

export class RecipientTransferError extends Error {
  constructor() { super('Invalid transfer or recipient passphrase.'); this.name = 'RecipientTransferError'; }
}

function validatePassphrase(passphrase: string) {
  if (typeof passphrase !== 'string' || passphrase === DEFAULT_PASSWORD
      || passphrase.length < 16 || Buffer.byteLength(passphrase, 'utf8') > 1024) throw new RecipientTransferError();
}

/** Fixed-cost, bounded, purpose-separated recipient envelope; no key metadata is exported. */
export async function sealRecipientTransfer(plaintext: Uint8Array, passphrase: string): Promise<Buffer> {
  validatePassphrase(passphrase);
  if (!plaintext.byteLength || plaintext.byteLength > MAX_TRANSFER_BYTES) throw new RecipientTransferError();
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  randomBytes(16).copy(header, 8);
  randomBytes(12).copy(header, 24);
  header.writeUInt32BE(plaintext.byteLength, 36);
  const key = await derive(passphrase, header.subarray(8, 24), KDF_ITERATIONS, 32, 'sha256');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24, 36));
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}

/** Authenticate the complete header and payload before returning any plaintext. */
export async function openRecipientTransfer(envelope: Uint8Array, passphrase: string): Promise<Buffer> {
  validatePassphrase(passphrase);
  if (envelope.byteLength < HEADER_BYTES + TAG_BYTES + 1
      || envelope.byteLength > HEADER_BYTES + TAG_BYTES + MAX_TRANSFER_BYTES) throw new RecipientTransferError();
  const bytes = Buffer.from(envelope);
  const header = bytes.subarray(0, HEADER_BYTES);
  if (!header.subarray(0, 8).equals(MAGIC)
      || header.readUInt32BE(36) !== bytes.length - HEADER_BYTES - TAG_BYTES) throw new RecipientTransferError();
  const key = await derive(passphrase, header.subarray(8, 24), KDF_ITERATIONS, 32, 'sha256');
  let provisional: Buffer | undefined;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(24, 36));
    cipher.setAAD(header);
    cipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    provisional = cipher.update(bytes.subarray(HEADER_BYTES, -TAG_BYTES));
    const final = cipher.final();
    return Buffer.concat([provisional, final]);
  } catch { throw new RecipientTransferError(); }
  finally { provisional?.fill(0); key.fill(0); bytes.fill(0); }
}
