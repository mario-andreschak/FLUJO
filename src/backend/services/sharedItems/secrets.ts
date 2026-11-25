import { MASKED_API_KEY } from '@/shared/types/constants';
import type { SharedItemKind } from './kinds';

/**
 * Keep secrets out of change history (#575). A history entry stores what an
 * item looked like after a change, with every secret value replaced by the
 * masked placeholder `********`. The save paths already read that placeholder
 * as "keep the stored secret", so restoring an older version never brings an
 * old key back and never needs one.
 *
 * Copying an item into another workspace uses stricter allowlists
 * (`teamCopy.ts`), because there the secrets must not even be referenced.
 */

const SECRET_KEY_ENDINGS = [
  'apikey', 'secret', 'password', 'passwd', 'passphrase', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken',
  'bearertoken', 'sessiontoken', 'privatekey', 'authorization', 'cookie', 'credential', 'credentials',
] as const;

/**
 * Keys whose values are secret wherever they appear (flow node settings
 * included): `ApiKey`, `clientSecret`, `password`, `token`, `oauthTokens`,
 * `Authorization`, … but not `maxTokens` or `contextTokens`.
 */
export function isSecretKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_\s.]/g, '');
  if (flat === 'token' || flat === 'tokens' || flat === 'bearer' || flat === 'oauthtokens') return true;
  return SECRET_KEY_ENDINGS.some(ending => flat.endsWith(ending));
}

/** A value FLUJO stored encrypted. Never copied and never kept in history. */
export function isEncryptedValue(value: unknown): boolean {
  return typeof value === 'string' && /^(?:encrypted:|encrypted_failed:|v2:[0-9a-f]+:)/.test(value);
}

/** A `${global:NAME}` reference names a workspace variable; it is not a secret itself. */
export function isGlobalReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{global:[^}]+\}$/.test(value.trim());
}

function maskValue(value: unknown): unknown {
  if (typeof value !== 'string' || value === '' || isGlobalReference(value)) return value;
  return MASKED_API_KEY;
}

/** Environment variables and headers: `string` or `{ value, metadata: { isSecret } }`. Plain strings count as secret only when they look like one. */
function maskEnvRecord(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record as Record<string, unknown>)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entry = raw as { value?: unknown; metadata?: { isSecret?: unknown } };
      const secret = entry.metadata?.isSecret === true || isSecretKey(key) || isEncryptedValue(entry.value);
      out[key] = secret ? { ...entry, value: maskValue(entry.value) } : entry;
    } else {
      out[key] = isSecretKey(key) || isEncryptedValue(raw) ? maskValue(raw) : raw;
    }
  }
  return out;
}

/** Walk any JSON value and mask secret-looking fields and encrypted values. */
export function maskSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (isEncryptedValue(value)) return MASKED_API_KEY;
  if (Array.isArray(value)) return value.map(item => maskSecretsDeep(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'env' || key === 'headers') out[key] = maskEnvRecord(item);
    else if (isSecretKey(key) && (typeof item === 'string' || typeof item === 'number')) out[key] = maskValue(item);
    else if (isSecretKey(key) && item && typeof item === 'object') out[key] = null;
    else out[key] = maskSecretsDeep(item, depth + 1);
  }
  return out;
}

const MCP_SECRET_FIELDS = [
  'oauthClientSecret', 'oauthTokens', 'oauthCodeVerifier', 'oauthState', 'oauthStateWorkspace', 'oauthStateCreatedAt',
  'oauthStateDiscovery', 'oauthClientInformation', 'authorizationUrl',
] as const;

/**
 * What a history entry keeps of an item: everything except secret values.
 * Models keep a `${global:…}` reference; MCP servers lose their OAuth tokens
 * and sign-in state; every other secret-looking value becomes `********`.
 */
export function historySnapshot(kind: SharedItemKind, item: unknown): unknown {
  if (!item || typeof item !== 'object') return null;
  const copy = structuredClone(item) as Record<string, unknown>;
  if (kind === 'mcp-server') {
    for (const field of MCP_SECRET_FIELDS) {
      if (field in copy) copy[field] = field === 'oauthClientSecret' ? maskValue(copy[field]) : undefined;
    }
  }
  return JSON.parse(JSON.stringify(maskSecretsDeep(copy)));
}

/**
 * Put the current secrets back into an older snapshot before it is saved
 * again: every masked value takes the value stored now at the same place, so
 * a restore changes settings but never a key.
 */
export function restoreSecrets(snapshot: unknown, current: unknown): unknown {
  if (snapshot === MASKED_API_KEY) return current === undefined ? MASKED_API_KEY : current;
  if (Array.isArray(snapshot)) {
    return snapshot.map((item, index) => restoreSecrets(item, Array.isArray(current) ? current[index] : undefined));
  }
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const out: Record<string, unknown> = {};
  const now = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  for (const [key, item] of Object.entries(snapshot as Record<string, unknown>)) out[key] = restoreSecrets(item, now[key]);
  return out;
}
