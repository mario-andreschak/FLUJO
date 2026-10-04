import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptedSnapshotSizeLimit } from './snapshotLimits';

const FORMAT = 'flujo-workspace-encrypted';
const PURPOSE = Buffer.from('flujo:workspace-snapshot:v2', 'utf8');
export const SNAPSHOT_ENCRYPTION_CAPABILITY = Object.freeze({
  format: FORMAT, cipher: 'aes-256-gcm', writeVersion: 2,
  readVersions: Object.freeze([1, 2] as const), legacyPlaintextRead: true,
  recipientKeyRequired: true, recipientKeyBytes: 32, recipientKeyEncoding: 'base64',
  v2Aad: 'flujo:workspace-snapshot:v2', v2Digest: 'sha256-encrypted-wire', v1Digest: 'sha256-plaintext-zip',
} as const);
const failure = () => new Error('Worker snapshot decryption failed. Check the encrypted archive and its recipient key.');

function decode(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw failure();
  return bytes;
}

/** The recipient supplies and independently retains a fresh random 32-byte key. */
export function parseSnapshotRecipientKey(value: unknown): Buffer {
  try {
    const key = decode(value);
    if (key.length !== 32) { key.fill(0); throw failure(); }
    return key;
  } catch { throw new Error('A recipient snapshot key containing 32 random bytes in canonical base64 is required.'); }
}

/** Only this encrypted representation may be persisted by new snapshot writers. */
export function encryptSnapshotEnvelope(archive: Buffer, recipientKey: Buffer): Buffer {
  if (!Buffer.isBuffer(recipientKey) || recipientKey.length !== 32) throw new Error('Snapshot recipient key is invalid.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', recipientKey, iv);
  cipher.setAAD(PURPOSE);
  const data = Buffer.concat([cipher.update(archive), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: FORMAT, version: 2, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), 'utf8');
}

/** v1 remains readable for already-created bridge envelopes; all new writes use v2. */
export function decryptSnapshotEnvelope(input: Buffer, recipientKey: unknown, maxBytes: number): { bytes: Buffer; version: 1 | 2 } {
  let key: Buffer | undefined;
  try {
    if (input.length > encryptedSnapshotSizeLimit(maxBytes)) throw failure();
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw failure();
    const fields = envelope as Record<string, unknown>;
    if (fields.format !== FORMAT || (fields.version !== 1 && fields.version !== 2)
      || Object.keys(fields).length !== 5) throw failure();
    key = parseSnapshotRecipientKey(recipientKey);
    const iv = decode(fields.iv);
    const tag = decode(fields.tag);
    const data = decode(fields.data);
    if (iv.length !== 12 || tag.length !== 16 || data.length > maxBytes) throw failure();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (fields.version === 2) decipher.setAAD(PURPOSE);
    decipher.setAuthTag(tag);
    return { bytes: Buffer.concat([decipher.update(data), decipher.final()]), version: fields.version };
  } catch { throw failure(); }
  finally { key?.fill(0); }
}
