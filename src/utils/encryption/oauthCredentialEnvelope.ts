/** Transfer/legacy adapters; runtime SDK schema and purpose parsing use one canonical helper. */
import { parseOAuthCredential, serializeOAuthCredential, type OAuthCredentialKind } from '@/backend/services/mcp/oauthCredentialStorage';
export type { OAuthCredentialKind } from '@/backend/services/mcp/oauthCredentialStorage';
export const OAUTH_CREDENTIAL_FORMAT = 'flujo-oauth-v1';
const MAX_CIPHERTEXT_BYTES = 512 * 1024;
const failure = () => new Error('OAuth credentials are malformed or belong to another workspace or purpose.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const encodeOAuthValue = serializeOAuthCredential;
export const decodeOAuthValue = (serialized: string, kind: OAuthCredentialKind, workspace: string) => parseOAuthCredential(kind, serialized, workspace);
function envelope(stored: unknown): boolean {
  return record(stored) && (stored.format === OAUTH_CREDENTIAL_FORMAT
    || (Object.hasOwn(stored, 'format') && Object.hasOwn(stored, 'ciphertext') && Object.keys(stored).length === 2));
}
async function legacy(value: unknown, decrypt: (ciphertext: string) => Promise<string>, transferTags: boolean, depth = 0): Promise<unknown> {
  if (depth > 100) throw failure();
  if (typeof value === 'string') {
    if (transferTags) return value; // Older transfer field tags already contain authenticated plaintext.
    if (value.startsWith('encrypted_failed:')) return value.slice('encrypted_failed:'.length);
    const ciphertext = value.startsWith('encrypted:') ? value.slice('encrypted:'.length)
      : value.startsWith('v2:') || /^[a-f0-9]{32}:[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
    return ciphertext === undefined ? value : decrypt(ciphertext);
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => legacy(item, decrypt, transferTags, depth + 1)));
  if (!record(value)) return value;
  if (transferTags && value.$flujoCredential === 1 && typeof value.plaintext === 'string' && Object.keys(value).length === 2) return value.plaintext;
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await legacy(item, decrypt, transferTags, depth + 1)])));
}
export async function readSourceOAuthValue(kind: OAuthCredentialKind, stored: unknown, workspace: string,
  decrypt: (ciphertext: string) => Promise<string>): Promise<unknown> {
  if (envelope(stored)) {
    if (!record(stored) || Object.keys(stored).length !== 2 || stored.format !== OAUTH_CREDENTIAL_FORMAT
        || typeof stored.ciphertext !== 'string' || !stored.ciphertext.startsWith('v2:')
        || Buffer.byteLength(stored.ciphertext) > MAX_CIPHERTEXT_BYTES) throw failure();
    return decodeOAuthValue(await decrypt(stored.ciphertext), kind, workspace);
  }
  const value = await legacy(stored, decrypt, false);
  // Bound legacy SDK objects too, before placing them in an encrypted journal/archive.
  encodeOAuthValue(kind, value, workspace);
  return value;
}
export function oauthTransferTag(kind: OAuthCredentialKind, value: unknown, workspace: string) {
  encodeOAuthValue(kind, value, workspace);
  return { $flujoOAuth: 1, kind, value };
}
export async function readTransferredOAuthValue(kind: OAuthCredentialKind, stored: unknown, workspace: string): Promise<unknown> {
  if (record(stored) && stored.$flujoOAuth === 1) {
    if (Object.keys(stored).length !== 3 || stored.kind !== kind || !Object.hasOwn(stored, 'value')) throw failure();
    encodeOAuthValue(kind, stored.value, workspace);
    return stored.value;
  }
  if (envelope(stored)) throw failure(); // Re-export old whole-envelope transfers with source binding validation.
  const value = await legacy(stored, async () => { throw failure(); }, true);
  encodeOAuthValue(kind, value, workspace);
  return value;
}
