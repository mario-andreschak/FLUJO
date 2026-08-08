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

const EMPTY_STORE: McpAppConsentStore = {};
const shippedPackageIds = new Set(SHIPPED_MCP_SERVERS.map((server) => server.packageId));

export function mcpAppConsentKey(serverName: string, uri: string): string {
  return `${serverName}::${uri}`;
}

export function isInternalMcpAppServer(config: MCPServerConfig | undefined): boolean {
  return config?.source?.type === 'marketplace'
    && typeof config.source.id === 'string'
    && shippedPackageIds.has(config.source.id);
}

async function loadStore(): Promise<McpAppConsentStore> {
  const stored = await loadItem<unknown>(StorageKey.MCP_APP_CONSENT, EMPTY_STORE);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as McpAppConsentStore
    : EMPTY_STORE;
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
