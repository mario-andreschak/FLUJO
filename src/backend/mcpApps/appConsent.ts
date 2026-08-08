import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import type { MCPServerConfig } from '@/shared/types/mcp';

export type McpAppConsentDecision = 'allow-once' | 'allow-always' | 'deny-always';
export type McpAppConsentStatus = 'internal' | 'granted' | 'prompt' | 'denied';

export interface McpAppConsentRecord {
  decision: McpAppConsentDecision;
  grantedFor?: string;
  updatedAt: number;
}

type McpAppConsentStore = Record<string, McpAppConsentRecord>;

const CONSENT_DECISIONS: ReadonlySet<string> = new Set<McpAppConsentDecision>([
  'allow-once',
  'allow-always',
  'deny-always',
]);
const shippedPackageIds = new Set(SHIPPED_MCP_SERVERS.map((server) => server.packageId));

/**
 * Always hand back a brand-new object. A shared module-level constant would be
 * mutated by `setMcpAppConsent` and would then leak those grants into every
 * later missing/malformed read, silently turning a fail-closed path into a
 * fail-open one.
 */
function emptyStore(): McpAppConsentStore {
  return {};
}

function isConsentRecord(value: unknown): value is McpAppConsentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<McpAppConsentRecord>;
  return typeof record.decision === 'string'
    && CONSENT_DECISIONS.has(record.decision)
    && (record.grantedFor === undefined || typeof record.grantedFor === 'string');
}

export function mcpAppConsentKey(serverName: string, uri: string): string {
  return `${serverName}::${uri}`;
}

export function isInternalMcpAppServer(config: MCPServerConfig | undefined): boolean {
  return config?.source?.type === 'marketplace'
    && typeof config.source.id === 'string'
    && shippedPackageIds.has(config.source.id);
}

async function loadStore(): Promise<McpAppConsentStore> {
  const stored = await loadItem<unknown>(StorageKey.MCP_APP_CONSENT, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyStore();

  // Copy into a fresh store so callers can never mutate persisted/default state
  // by reference, and drop entries that are not well-formed consent records.
  const store = emptyStore();
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!isConsentRecord(value)) continue;
    store[key] = {
      decision: value.decision,
      ...(typeof value.grantedFor === 'string' ? { grantedFor: value.grantedFor } : {}),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    };
  }
  return store;
}

export async function getMcpAppConsent(
  config: MCPServerConfig | undefined,
  serverName: string,
  uri: string,
  conversationId?: string,
): Promise<McpAppConsentStatus> {
  if (isInternalMcpAppServer(config)) return 'internal';
  const record = (await loadStore())[mcpAppConsentKey(serverName, uri)];
  if (!record) return 'prompt';
  if (record.decision === 'deny-always') return 'denied';
  if (record.decision === 'allow-always') return 'granted';
  return record.decision === 'allow-once' && record.grantedFor === conversationId
    ? 'granted'
    : 'prompt';
}

export async function setMcpAppConsent(
  serverName: string,
  uri: string,
  decision: McpAppConsentDecision,
  conversationId?: string,
): Promise<void> {
  const store = await loadStore();
  store[mcpAppConsentKey(serverName, uri)] = {
    decision,
    ...(decision === 'allow-once' && conversationId ? { grantedFor: conversationId } : {}),
    updatedAt: Date.now(),
  };
  await saveItem(StorageKey.MCP_APP_CONSENT, store);
}
