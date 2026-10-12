import type { MCPHeaderValue } from '@/shared/types/mcp/mcp';
import { isMaskedHeaderValue, normalizeHeaderValue } from './headers';

export const MCP_HEADER_DESTINATION_CHANGED =
  'The server destination or transport changed. Re-enter or remove the saved secret headers before testing or saving.';

type HeaderDestination = { transport?: unknown; serverUrl?: unknown };
type Headers = Record<string, MCPHeaderValue> | undefined;

export function usesMcpHttpHeaders(config: HeaderDestination): boolean {
  return config.transport === 'streamable' || config.transport === 'sse';
}

/** Use the URL representation the HTTP transports consume, including path and query. */
function httpDestination(config: HeaderDestination): string | undefined {
  if (!usesMcpHttpHeaders(config)) return;
  if (typeof config.serverUrl !== 'string') return;
  try {
    const url = new URL(config.serverUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return;
    // Fragments are not sent in an HTTP request.
    url.hash = '';
    return url.href;
  } catch {
    return;
  }
}

/** Names may change; automatic saved-header reuse stays bound to endpoint and transport. */
export function isSameMcpHeaderDestination(
  requested: HeaderDestination,
  stored: HeaderDestination | undefined,
): boolean {
  if (!stored || requested.transport !== stored.transport) return false;
  const destination = httpDestination(requested);
  return destination !== undefined && destination === httpDestination(stored);
}

/** A probe or explicit header edit would restore a masked value from the saved record. */
export function hasMaskedStoredHeaders(incoming: Headers, stored: Headers): boolean {
  return Object.entries(incoming ?? {}).some(([key, raw]) => {
    if (!key) return false;
    const { value, isSecret } = normalizeHeaderValue(raw, key);
    const previous = stored?.[key];
    if (!isSecret || !isMaskedHeaderValue(value) || previous === undefined) return false;
    const previousValue = normalizeHeaderValue(previous, key).value;
    return !!previousValue && !isMaskedHeaderValue(previousValue);
  });
}

/** An edit omitting headers would inherit saved secret material through the config merge. */
export function hasStoredSecretHeaders(stored: Headers): boolean {
  return Object.entries(stored ?? {}).some(([key, raw]) => {
    if (!key) return false;
    const { value, isSecret } = normalizeHeaderValue(raw, key);
    return isSecret && !!value && !isMaskedHeaderValue(value);
  });
}
