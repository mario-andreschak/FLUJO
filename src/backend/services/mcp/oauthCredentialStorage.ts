import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPEncryptedOAuthValue, MCPStreamableConfig } from '@/shared/types/mcp';
import { encryptWithPassword, decryptWithPassword, isEncryptionLocked } from '@/utils/encryption/secure';
import { getCurrentWorkspace } from '@/utils/workspace';

type Kind = 'tokens' | 'client' | 'verifier';
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 512 * 1024;
const FORMAT = 'flujo-oauth-v1';
const failure = () => new Error('Stored OAuth credentials are unavailable. Unlock this workspace or restore matching credentials.');

/** Historical plaintext is compatibility data, not permission to bypass lock. */
export async function assertOAuthCredentialsAvailable(): Promise<void> {
  try {
    if (await isEncryptionLocked()) throw failure();
  } catch { throw failure(); }
}

/** Encrypt the whole value, including unknown provider extension fields. */
export async function sealOAuthCredential(kind: Kind, value: unknown): Promise<MCPEncryptedOAuthValue> {
  try {
    const serialized = JSON.stringify({ format: FORMAT, kind, workspace: getCurrentWorkspace(), value });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure();
    // Validate the representation that will be committed, including toJSON output.
    validate(kind, (JSON.parse(serialized) as { value: unknown }).value);
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
  if (!record(stored) || (stored.format !== FORMAT
    && !(Object.hasOwn(stored, 'format') && Object.hasOwn(stored, 'ciphertext') && Object.keys(stored).length === 2))) return stored;
  try {
    if (stored.format !== FORMAT || typeof stored.ciphertext !== 'string'
      || !stored.ciphertext.startsWith('v2:') || Object.keys(stored).length !== 2
      || Buffer.byteLength(stored.ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) throw failure();
    const serialized = await decryptWithPassword(stored.ciphertext);
    if (serialized === null || Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure();
    const decoded: unknown = JSON.parse(serialized);
    if (!record(decoded) || decoded.format !== FORMAT || decoded.kind !== kind
      || decoded.workspace !== getCurrentWorkspace() || !Object.hasOwn(decoded, 'value')) throw failure();
    return decoded.value;
  } catch {
    throw failure();
  }
}

export async function readOAuthTokens(config: MCPStreamableConfig): Promise<OAuthTokens | undefined> {
  if (config.oauthTokens === undefined) return undefined;
  const value = await read('tokens', config.oauthTokens);
  validate('tokens', value);
  return value as OAuthTokens;
}

export async function readOAuthClientInformation(config: MCPStreamableConfig): Promise<OAuthClientInformation | undefined> {
  if (config.oauthClientInformation === undefined) return undefined;
  const value = await read('client', config.oauthClientInformation);
  validate('client', value);
  return value as OAuthClientInformation;
}

export async function readOAuthCodeVerifier(config: MCPStreamableConfig): Promise<string> {
  const value = await read('verifier', config.oauthCodeVerifier);
  validate('verifier', value);
  return value as string;
}
