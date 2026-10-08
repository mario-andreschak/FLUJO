/** Host-reserved provenance, written after an MCP server returns a tool result. */
export const MCP_APP_OWNER_SCOPE_META = 'io.flujo/host-owner-scope';

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

function validOwnerScope(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value;
}

/**
 * The shared MCP dispatch boundary supplies this value from the host's request,
 * never from server output. Overwrite (or remove) any server-supplied claim.
 * Persisting it with the result keeps a historical View attached to the run
 * that created its resources even after the conversation starts another run.
 * This is an ownership namespace, not a new authorization capability.
 */
export function stampMcpAppOwnerScope(result: unknown, ownerScope?: string): unknown {
  const record = asRecord(result);
  if (!record) return result;
  const meta = asRecord(record._meta);
  const scope = validOwnerScope(ownerScope) ? ownerScope : undefined;
  if (scope === undefined && !Object.hasOwn(meta ?? {}, MCP_APP_OWNER_SCOPE_META)) return result;
  const nextMeta = { ...meta };
  delete nextMeta[MCP_APP_OWNER_SCOPE_META];
  if (scope !== undefined) nextMeta[MCP_APP_OWNER_SCOPE_META] = scope;
  return { ...record, _meta: nextMeta };
}

/** Read only FLUJO's host-stamped top-level result metadata, never tool content. */
export function mcpAppOwnerScopeFromResult(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const meta = asRecord(asRecord(result)?._meta);
    const scope = meta?.[MCP_APP_OWNER_SCOPE_META];
    return validOwnerScope(scope) ? scope : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the View's host-bound scope without accepting scope from App RPC arguments. */
export function resolveMcpAppOwnerScope(input: {
  toolOwnerScope?: string;
  toolResultContent?: string;
  conversationId?: string;
  ownerScopeId?: string;
  serverName: string;
  uri: string;
  frameInstanceId: string;
}): string {
  const originatingOwner = validOwnerScope(input.toolOwnerScope)
    ? input.toolOwnerScope
    : mcpAppOwnerScopeFromResult(input.toolResultContent);
  if (originatingOwner) return originatingOwner;
  if (input.conversationId) return `conversation:${input.conversationId}`;
  if (input.ownerScopeId?.trim()) return `app:${input.ownerScopeId.trim().slice(0, 500)}`;
  return `app:${input.serverName}:${input.uri}:${input.frameInstanceId}`;
}
