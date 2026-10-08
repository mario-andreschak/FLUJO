import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
export const KDF_ITERATIONS = 600_000;
export const DEFAULT_PASSWORD = 'FLUJO~'; // Compatibility/obfuscation only; not a secret.
export type EncryptionType = 'default' | 'user';
export interface Keyring {
  version: 2;
  activeKey: string;
  /** Effective UTF-8 key bytes used by v1, retained only for old ciphertext. */
  legacyKey?: string;
}
export interface EncryptionMetadata {
  encryption_version: number;
  encryption_type?: EncryptionType;
  data_encryption_key: string;
  data_encryption_salt: string;
  data_encryption_iv?: string;
  key_id?: string;
  kdf?: string;
  kdf_iterations?: number;
}

function hex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value);
}

export function parseKeyring(value: unknown): Keyring {
  if (!value || typeof value !== 'object') throw new Error('Invalid encryption keyring');
  const ring = value as Keyring;
  if (ring.version !== 2 || !hex(ring.activeKey, 32)
      || (ring.legacyKey !== undefined && !hex(ring.legacyKey, 16))) {
    throw new Error('Invalid encryption keyring');
  }
  return { version: 2, activeKey: ring.activeKey, ...(ring.legacyKey ? { legacyKey: ring.legacyKey } : {}) };
}

export function newKeyring(legacyKey?: string): Keyring {
  return parseKeyring({ version: 2, activeKey: randomBytes(32).toString('hex'), legacyKey });
}

export function keyId(ring: Keyring): string {
  return createHash('sha256').update(Buffer.from(ring.activeKey, 'hex')).digest('hex');
}

export function serializeKeyring(ring: Keyring): string {
  return `v2:${JSON.stringify(parseKeyring(ring))}`;
}

export function parseSessionKey(value: string): Keyring | { legacyKey: string } {
  if (value.startsWith('v2:')) return parseKeyring(JSON.parse(value.slice(3)));
  // v1 server/session state stored the effective AES-128 key as 32 hex chars.
  if (hex(value, 16)) return { legacyKey: value };
  throw new Error('Invalid encryption session key');
}

export function isValidEncryptionSessionKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { parseSessionKey(value); return true; } catch { return false; }
}

export function seal(plaintext: string, key: string, purpose: string): string {
  if (!hex(key, 32)) throw new Error('Invalid AES-256 key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v2:${nonce.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

export function open(envelope: string, key: string, purpose: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== 'v2' || !hex(parts[1], 12) || !hex(parts[2], 16)
      || !hex(key, 32) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parts[3])) {
    throw new Error('Invalid authenticated ciphertext');
  }
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(parts[1], 'hex'));
  cipher.setAAD(Buffer.from(purpose));
  cipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(parts[3], 'base64')), cipher.final()]).toString('utf8');
}

export async function wrapKeyring(ring: Keyring, type: EncryptionType, password: string): Promise<EncryptionMetadata> {
  const salt = randomBytes(16);
  const wrappingKey = await derive(password, salt, KDF_ITERATIONS, 32, 'sha256');
  const id = keyId(ring);
  return {
    encryption_version: 2, encryption_type: type, key_id: id,
    kdf: 'pbkdf2-sha256', kdf_iterations: KDF_ITERATIONS,
    data_encryption_salt: salt.toString('hex'),
    data_encryption_key: seal(JSON.stringify(ring), wrappingKey.toString('hex'), `flujo:keyring:v2:${type}:${id}`),
  };
}

export async function unwrapKeyring(metadata: EncryptionMetadata, password: string): Promise<Keyring> {
  if (metadata.encryption_version !== 2 || metadata.kdf !== 'pbkdf2-sha256'
      || metadata.kdf_iterations !== KDF_ITERATIONS || !hex(metadata.data_encryption_salt, 16)
      || !hex(metadata.key_id, 32) || !['default', 'user'].includes(metadata.encryption_type ?? '')) {
    throw new Error('Unsupported encryption metadata');
  }
  const wrappingKey = await derive(password, Buffer.from(metadata.data_encryption_salt, 'hex'), KDF_ITERATIONS, 32, 'sha256');
  const ring = parseKeyring(JSON.parse(open(metadata.data_encryption_key, wrappingKey.toString('hex'),
    `flujo:keyring:v2:${metadata.encryption_type}:${metadata.key_id}`)));
  if (keyId(ring) !== metadata.key_id) throw new Error('Encryption key identity mismatch');
  return ring;
}

/** The old format is read-only. Never generate new CBC metadata or ciphertext. */
export async function unwrapLegacyKey(metadata: EncryptionMetadata, password: string): Promise<string> {
  if (metadata.encryption_version !== 1 || !hex(metadata.data_encryption_iv, 16)) {
    throw new Error('Unsupported legacy encryption metadata');
  }
  const salt = metadata.encryption_type === 'user'
    ? Buffer.from(metadata.data_encryption_salt, 'hex') : Buffer.from('flujo_fixed_salt_v1');
  if (metadata.encryption_type === 'user' && !hex(metadata.data_encryption_salt, 16)) {
    throw new Error('Invalid legacy encryption salt');
  }
  const wrappingKey = await derive(password, salt, 100_000, 32, 'sha256');
  const cipher = createDecipheriv('aes-256-cbc', wrappingKey, Buffer.from(metadata.data_encryption_iv, 'hex'));
  const text = Buffer.concat([cipher.update(Buffer.from(metadata.data_encryption_key, 'base64')), cipher.final()]).toString('utf8');
  if (!hex(text, 8)) throw new Error('Invalid legacy encryption key');
  return Buffer.from(text, 'utf8').toString('hex');
}

export function decryptLegacy(ciphertext: string, key: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 2 || !hex(parts[0], 16) || !hex(key, 16)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new Error('Invalid legacy ciphertext');
  const cipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'hex'), Buffer.from(parts[0], 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(parts[1], 'base64')), cipher.final()]).toString('utf8');
}
