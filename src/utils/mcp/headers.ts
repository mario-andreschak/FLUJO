/**
 * Pure helpers for remote-MCP custom HTTP headers (#84).
 *
 * Headers reuse the env-var value shape (`MCPHeaderValue = EnvVarValue`): a plain string is
 * the legacy / non-secret form, and `{ value, metadata: { isSecret } }` carries a per-header
 * secret flag. These helpers are free of React/crypto so they can be unit-tested and shared
 * between the GET-route masking, the save contract, and the connect-time resolution.
 */
import { MCPHeaderValue } from '@/shared/types/mcp/mcp';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import { isSecretHeaderKey } from '@/utils/shared/common';

export { isSecretHeaderKey };

const GLOBAL_BINDING_PREFIX = '${global:';

/** True when the value is a `${global:VAR}` binding (stored/sent verbatim, resolved at connect). */
export function isGlobalBinding(value: string): boolean {
  return typeof value === 'string' && value.startsWith(GLOBAL_BINDING_PREFIX);
}

/**
 * Normalize either header value form into `{ value, isSecret }`. For the legacy plain-string
 * form the secret flag is inferred from the header name (so an old `Authorization` header is
 * still treated as secret without a migration).
 */
export function normalizeHeaderValue(raw: MCPHeaderValue, key: string): { value: string; isSecret: boolean } {
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return { value: raw.value ?? '', isSecret: !!raw.metadata?.isSecret };
  }
  return { value: (raw as string) ?? '', isSecret: isSecretHeaderKey(key) };
}

/** Flatten headers to a plain string map (e.g. for external Claude/Cline config export). */
export function flattenHeaders(headers?: Record<string, MCPHeaderValue>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, raw] of Object.entries(headers)) {
    if (!key) continue;
    out[key] = normalizeHeaderValue(raw, key).value;
  }
  return out;
}

/**
 * Replace secret, non-bound header values with {@link MASKED_API_KEY} before the config is
 * sent to the browser. Global-variable bindings are left intact (so the editor can show the
 * "bound" state); non-secret values pass through unchanged. Encrypted/plaintext secret
 * material is never sent out.
 */
export function maskServerHeaders(
  headers?: Record<string, MCPHeaderValue>,
): Record<string, MCPHeaderValue> | undefined {
  if (!headers) return headers;
  const out: Record<string, MCPHeaderValue> = {};
  for (const [key, raw] of Object.entries(headers)) {
    if (!key) continue;
    const { value, isSecret } = normalizeHeaderValue(raw, key);
    if (isSecret && value && !isGlobalBinding(value)) {
      out[key] = { value: MASKED_API_KEY, metadata: { isSecret: true } };
    } else if (raw && typeof raw === 'object') {
      out[key] = { value, metadata: { isSecret } };
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/** A value the browser sends meaning "keep the stored secret unchanged". */
export function isMaskedHeaderValue(value: string): boolean {
  return value === MASKED_API_KEY || value === MASKED_STRING;
}

/**
 * For a test/connect operation, replace a masked SECRET header value the browser sent back
 * (MASKED_API_KEY / MASKED_STRING = "keep the stored secret") with the real stored value from
 * the saved config, mirroring resolveHeadersForSave's masked->keep contract EXACTLY: the
 * masked->keep substitution applies only when the header is secret, so a non-secret header
 * whose literal value happens to be "********" passes through untouched (just like the save
 * path stores it verbatim — the resolveConfigHeaders guard still stops the literal mask from
 * ever being sent on the wire). A masked secret with no stored counterpart (new/unsaved
 * server) is dropped, so the probe omits it and the remote server returns a meaningful
 * "authentication required" instead of "badly formatted". All other values pass through.
 *
 * This runs entirely server-side (never in the browser), so the real encrypted/bound secret
 * is only ever read from disk here — it is never sent to the frontend.
 */
export function hydrateMaskedHeaders(
  incoming?: Record<string, MCPHeaderValue>,
  stored?: Record<string, MCPHeaderValue>,
): Record<string, MCPHeaderValue> | undefined {
  if (!incoming) return incoming;
  const out: Record<string, MCPHeaderValue> = {};
  for (const [key, raw] of Object.entries(incoming)) {
    if (!key) continue;
    const { value, isSecret } = normalizeHeaderValue(raw, key);
    if (isSecret && isMaskedHeaderValue(value)) {
      const prev = stored?.[key];
      if (prev !== undefined) out[key] = prev;   // real encrypted/bound value from disk
      // else: drop (no stored value to test with)
      continue;
    }
    out[key] = raw;                              // plaintext / ${global:} / encrypted pass through
  }
  return out;
}
