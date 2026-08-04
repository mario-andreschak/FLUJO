import { readUiPreference, writeUiPreference } from '@/frontend/hooks/useUiPreference';

const MCP_APP_DISMISSED_PREF_PREFIX = 'flujo-ui:mcp-canvas:dismissed:';

export function dismissedMcpAppPreferenceKey(conversationId: string): string {
  return `${MCP_APP_DISMISSED_PREF_PREFIX}${conversationId}`;
}

export function readDismissedMcpAppKeys(conversationId: string): string[] {
  const stored = readUiPreference<unknown>(dismissedMcpAppPreferenceKey(conversationId), []);
  return Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === 'string')
    : [];
}

export function writeMcpAppDismissed(
  conversationId: string,
  appKey: string,
  dismissed: boolean,
): void {
  const keys = new Set(readDismissedMcpAppKeys(conversationId));
  if (dismissed) keys.add(appKey);
  else keys.delete(appKey);
  writeUiPreference(dismissedMcpAppPreferenceKey(conversationId), [...keys]);
}
