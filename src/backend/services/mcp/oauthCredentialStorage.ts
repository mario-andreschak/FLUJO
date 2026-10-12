import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPEncryptedOAuthValue, MCPStreamableConfig } from '@/shared/types/mcp';
import { encryptWithPassword, decryptWithPassword, isEncryptionLocked } from '@/utils/encryption/secure';
import { getCurrentWorkspace } from '@/utils/workspace';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';

export type OAuthCredentialKind = 'tokens' | 'client' | 'verifier';
type Kind = OAuthCredentialKind;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 512 * 1024;
const FORMAT = 'flujo-oauth-v1';
const failure = () => new Error('Stored OAuth credentials are unavailable. Unlock this workspace or restore matching credentials.');

/** Internal transfer seam; caller decrypts with the source key and reseals with the recipient key. */
export function serializeOAuthCredential(kind: Kind, value: unknown, workspace: string): string {
  try {
    const serialized = JSON.stringify({ format: FORMAT, kind, workspace, value });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure();
    validate(kind, (JSON.parse(serialized) as { value: unknown }).value);
    return serialized;
  } catch { throw failure(); }
}

export function parseOAuthCredential(kind: Kind, serialized: string, workspace: string): unknown {
  try {
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure();
    const decoded: unknown = JSON.parse(serialized);
    if (!record(decoded) || decoded.format !== FORMAT || decoded.kind !== kind
      || decoded.workspace !== workspace || Object.keys(decoded).sort().join(',') !== 'format,kind,value,workspace') throw failure();
    validate(kind, decoded.value);
    return decoded.value;
  } catch { throw failure(); }
}

/** Historical plaintext is compatibility data, not permission to bypass lock. */
export async function assertOAuthCredentialsAvailable(): Promise<void> {
  try {
    if (await isEncryptionLocked()) throw failure();
  } catch { throw failure(); }
}

/** Encrypt the whole value, including unknown provider extension fields. */
export async function sealOAuthCredential(kind: Kind, value: unknown): Promise<MCPEncryptedOAuthValue> {
  try {
    const serialized = serializeOAuthCredential(kind, value, getCurrentWorkspace());
    const ciphertext = await encryptWithPassword(serialized);
    if (!ciphertext?.startsWith('v2:')) throw failure();
    return { format: FORMAT, ciphertext };
  } catch {
    // Provider objects, parser errors and encryption errors may contain secrets.
    throw new Error('OAuth credential encryption failed; previous credentials have been retained.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function envelope(value: unknown): boolean {
  return record(value) && (value.format === FORMAT
    || (Object.hasOwn(value, 'format') && Object.hasOwn(value, 'ciphertext') && Object.keys(value).length === 2));
}

async function readLegacySecret(value: string): Promise<string> {
  if (!value.startsWith('encrypted:') && !value.startsWith('encrypted_failed:') && !value.includes('${global:')) return value;
  try {
    const plaintext = await resolveAndDecryptApiKey(value);
    if (!plaintext || plaintext === '********' || plaintext.startsWith('encrypted:') || plaintext.includes('${global:')) throw failure();
    return plaintext;
  } catch { throw failure(); }
}

function validate(kind: Kind, value: unknown): void {
  if (kind === 'verifier') {
    if (typeof value !== 'string' || !value) throw failure();
  } else if (kind === 'tokens') {
    if (!record(value) || typeof value.access_token !== 'string' || !value.access_token
      || typeof value.token_type !== 'string' || !value.token_type
      || (value.refresh_token !== undefined && typeof value.refresh_token !== 'string')) throw failure();
  } else if (!record(value) || typeof value.client_id !== 'string' || !value.client_id
    || (value.client_secret !== undefined && typeof value.client_secret !== 'string')) throw failure();
}

async function read(kind: Kind, stored: unknown): Promise<unknown> {
  await assertOAuthCredentialsAvailable();
  // Provider extensions may themselves be named format/ciphertext. Reserve our
  // explicit marker, plus the two-field envelope shape, without stripping legacy SDK data.
  if (!envelope(stored)) return stored;
  try {
    if (!record(stored)) throw failure();
    if (stored.format !== FORMAT || typeof stored.ciphertext !== 'string'
      || !stored.ciphertext.startsWith('v2:') || Object.keys(stored).length !== 2
      || Buffer.byteLength(stored.ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) throw failure();
    const serialized = await decryptWithPassword(stored.ciphertext);
    if (serialized === null || Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure();
    return parseOAuthCredential(kind, serialized, getCurrentWorkspace());
  } catch {
    throw failure();
  }
}

export async function readOAuthTokens(config: MCPStreamableConfig): Promise<OAuthTokens | undefined> {
  if (config.oauthTokens === undefined) return undefined;
  const value = await read('tokens', config.oauthTokens);
  validate('tokens', value);
  const tokens = { ...value as OAuthTokens };
  if (!envelope(config.oauthTokens)) {
    for (const field of ['access_token', 'refresh_token', 'id_token'] as const) {
      if (typeof tokens[field] === 'string') tokens[field] = await readLegacySecret(tokens[field]);
    }
  }
  return tokens;
}

export async function readOAuthClientInformation(config: MCPStreamableConfig): Promise<OAuthClientInformation | undefined> {
  if (config.oauthClientInformation === undefined) return undefined;
  const value = await read('client', config.oauthClientInformation);
  validate('client', value);
  const client = { ...value as OAuthClientInformation };
  if (!envelope(config.oauthClientInformation) && client.client_secret !== undefined) {
    client.client_secret = await readLegacySecret(client.client_secret);
  }
  return client;
}

export async function readOAuthCodeVerifier(config: MCPStreamableConfig): Promise<string> {
  const value = await read('verifier', config.oauthCodeVerifier);
  validate('verifier', value);
  return envelope(config.oauthCodeVerifier) ? value as string : readLegacySecret(value as string);
}
