import { readUiPreference, writeUiPreference } from '@/frontend/hooks/useUiPreference';
import { workspacePrefixedStorageKey } from '@/frontend/utils/workspaceSelection';

const MCP_APP_DISMISSED_PREF_PREFIX = 'flujo-ui:mcp-canvas:dismissed:';

export function dismissedMcpAppPreferenceKey(conversationId: string): string {
  return workspacePrefixedStorageKey(`${MCP_APP_DISMISSED_PREF_PREFIX}${conversationId}`);
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

/**
 * Batch variant of {@link writeMcpAppDismissed}, used when collapsing (or
 * closing all) the canvas dismisses every currently-docked app key at once
 * (issue #375).
 */
export function writeMcpAppsDismissed(
  conversationId: string,
  appKeys: readonly string[],
  dismissed: boolean,
): void {
  if (appKeys.length === 0) return;
  const keys = new Set(readDismissedMcpAppKeys(conversationId));
  for (const appKey of appKeys) {
    if (dismissed) keys.add(appKey);
    else keys.delete(appKey);
  }
  writeUiPreference(dismissedMcpAppPreferenceKey(conversationId), [...keys]);
}

/**
 * #375: root cause of "the canvas keeps re-opening after I collapsed it" —
 * collapsing was a pure UI toggle with no link to the auto-open path. This
 * flag is an explicit, per-conversation "the user does not want automatic
 * apps right now" intent. It is set when the user collapses the dock and
 * cleared on any manual open / re-expand / fullscreen. Manual opens always
 * bypass this flag.
 */
export const MCP_APP_AUTO_OPEN_SUPPRESSED_PREFIX = 'flujo-ui:mcp-canvas:auto-open-suppressed:';

export function autoOpenSuppressedPreferenceKey(conversationId: string): string {
  return workspacePrefixedStorageKey(`${MCP_APP_AUTO_OPEN_SUPPRESSED_PREFIX}${conversationId}`);
}

export function readAutoOpenSuppressed(conversationId: string): boolean {
  return readUiPreference<boolean>(autoOpenSuppressedPreferenceKey(conversationId), false) === true;
}

export function writeAutoOpenSuppressed(conversationId: string, suppressed: boolean): void {
  writeUiPreference(autoOpenSuppressedPreferenceKey(conversationId), suppressed);
}
