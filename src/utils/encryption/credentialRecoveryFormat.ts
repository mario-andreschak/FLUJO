import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isValidWorkspaceName } from '@/utils/workspace';

export const CREDENTIAL_RECOVERY_FILES = Object.freeze([
  'encryption_key.json', 'models.json', 'registry_account.json', 'global_env_vars.json', 'mcp_servers.json',
] as const);
export type CredentialRecoveryFile = typeof CREDENTIAL_RECOVERY_FILES[number];
export type CredentialRecoveryIdentity = {
  workspace: string;
  transactionId: string;
} & ({ role: 'manifest'; file?: never } | { role: 'before' | 'after'; file: CredentialRecoveryFile });

export const CREDENTIAL_RECOVERY_FILE_LIMIT = 8 * 1024 * 1024;
export const CREDENTIAL_RECOVERY_MANIFEST_LIMIT = 64 * 1024;
const FORMAT = 'flujo-credential-recovery';
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class CredentialRecoveryFormatError extends Error {
  constructor(readonly code: 'RECOVERY_INPUT' | 'RECOVERY_AUTH' | 'RECOVERY_SIZE') {
    const messages = {
      RECOVERY_INPUT: 'Credential recovery input is invalid; retain the original workspace and retry the explicit recovery operation.',
      RECOVERY_AUTH: 'Credential recovery data is invalid or unauthenticated; retain it and supply the matching independently retained key.',
      RECOVERY_SIZE: 'Credential recovery data exceeds its limits; retain the original workspace and use a supported recovery procedure.',
    };
    super(messages[code]);
    this.name = 'CredentialRecoveryFormatError';
  }
}

function identityData(identity: CredentialRecoveryIdentity): { aad: Buffer; limit: number } {
  try {
    if (!identity || typeof identity !== 'object' || !isValidWorkspaceName(identity.workspace)
        || typeof identity.transactionId !== 'string' || !UUID_V4.test(identity.transactionId)) throw new Error();
    const manifest = identity.role === 'manifest';
    const fields = manifest ? ['workspace', 'transactionId', 'role'] : ['workspace', 'transactionId', 'role', 'file'];
    if (Object.keys(identity).length !== fields.length || fields.some(field => !Object.hasOwn(identity, field))
        || (!manifest && (!['before', 'after'].includes(identity.role)
          || !CREDENTIAL_RECOVERY_FILES.includes(identity.file)))) throw new Error();
    return {
      aad: Buffer.from(JSON.stringify({ format: FORMAT, version: 1, workspace: identity.workspace,
        transactionId: identity.transactionId, role: identity.role, ...(manifest ? {} : { file: identity.file }) })),
      limit: manifest ? CREDENTIAL_RECOVERY_MANIFEST_LIMIT : CREDENTIAL_RECOVERY_FILE_LIMIT,
    };
  } catch { throw new CredentialRecoveryFormatError('RECOVERY_INPUT'); }
}

export function assertCredentialRecoveryIdentity(identity: CredentialRecoveryIdentity): void {
  identityData(identity);
}

function ownedKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new CredentialRecoveryFormatError('RECOVERY_INPUT');
  // This copy belongs to the crypto operation. Never erase the independently
  // retained caller key; each operation clears its own copy on every outcome.
  return Buffer.from(key);
}

/** Encrypt one bounded recovery object; the separately retained key is never persisted. */
export function encryptCredentialRecoveryObject(
  plaintext: Buffer, key: Buffer, identity: CredentialRecoveryIdentity,
): Buffer {
  const { aad, limit } = identityData(identity);
  if (!Buffer.isBuffer(plaintext)) throw new CredentialRecoveryFormatError('RECOVERY_INPUT');
  if (plaintext.length > limit) throw new CredentialRecoveryFormatError('RECOVERY_SIZE');
  const copy = ownedKey(key);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', copy, iv);
    cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ format: FORMAT, version: 1, iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') }));
  } catch { throw new CredentialRecoveryFormatError('RECOVERY_AUTH'); }
  finally { copy.fill(0); }
}

/** Return owned bytes only after authentication. The caller must clear the returned buffer. */
export function decryptCredentialRecoveryObject(
  wire: Buffer, key: Buffer, identity: CredentialRecoveryIdentity,
): Buffer {
  const { aad, limit } = identityData(identity);
  let copy: Buffer | undefined;
  let chunk: Buffer | undefined;
  let end: Buffer | undefined;
  try {
    if (!Buffer.isBuffer(wire) || wire.length > 4 * Math.ceil(limit / 3) + 4096) {
      throw new CredentialRecoveryFormatError('RECOVERY_SIZE');
    }
    copy = ownedKey(key);
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire));
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error();
    const fields = envelope as Record<string, unknown>;
    const names = ['format', 'version', 'iv', 'tag', 'data'];
    if (Object.keys(fields).length !== names.length || names.some(name => !Object.hasOwn(fields, name))
        || fields.format !== FORMAT || fields.version !== 1 || typeof fields.iv !== 'string'
        || !/^[a-f0-9]{24}$/.test(fields.iv) || typeof fields.tag !== 'string' || !/^[a-f0-9]{32}$/.test(fields.tag)
        || typeof fields.data !== 'string' || fields.data.length > 4 * Math.ceil(limit / 3)) throw new Error();
    const data = Buffer.from(fields.data, 'base64');
    if (data.length > limit || data.toString('base64') !== fields.data) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', copy, Buffer.from(fields.iv, 'hex'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(fields.tag, 'hex'));
    chunk = decipher.update(data);
    end = decipher.final();
    return Buffer.concat([chunk, end]);
  } catch (error) {
    if (error instanceof CredentialRecoveryFormatError && error.code === 'RECOVERY_SIZE') throw error;
    throw new CredentialRecoveryFormatError('RECOVERY_AUTH');
  } finally {
    // update() can emit unauthenticated plaintext before final() rejects. Keep
    // its owned buffer reachable and erase it on success and authentication failure.
    chunk?.fill(0);
    end?.fill(0);
    copy?.fill(0);
  }
}
