"use client";

import { StorageKey } from '@/shared/types/storage';
import { TICKET_DRAFT_STORAGE_KEY } from '@/shared/types/ticket';
import {
  DEFAULT_WORKSPACE,
  getSelectedWorkspace,
  workspaceLocalStorageKey,
  workspacePrefixedStorageKey,
  workspaceSessionKey,
} from './workspaceSelection';

export const FLOW_CLIPBOARD_STORAGE_KEY = 'flujo:flowClipboard';
export const ASK_FLUJO_MODEL_STORAGE_KEY = 'flujo-ui:ask-flujo:model';

export function flowClipboardStorageKey(): string {
  return workspaceLocalStorageKey(FLOW_CLIPBOARD_STORAGE_KEY);
}

export function ticketDraftStorageKey(): string {
  return workspaceSessionKey(TICKET_DRAFT_STORAGE_KEY);
}

export function currentConversationStorageKey(): string {
  return workspaceLocalStorageKey(StorageKey.CURRENT_CONVERSATION_ID);
}

export function askFlujoModelStorageKey(): string {
  return workspaceLocalStorageKey(ASK_FLUJO_MODEL_STORAGE_KEY);
}

const LEGACY_LOCAL_KEYS = [
  FLOW_CLIPBOARD_STORAGE_KEY,
  ASK_FLUJO_MODEL_STORAGE_KEY,
  StorageKey.CURRENT_CONVERSATION_ID,
] as const;
const LEGACY_SESSION_KEYS = [
  TICKET_DRAFT_STORAGE_KEY,
  'encryption_authenticated',
  'encryption_token',
  'encryption_key',
] as const;
const LEGACY_LOCAL_PREFIXES = [
  'flujo-ui:mcp-canvas:dismissed:',
  'flujo-ui:mcp-canvas:auto-open-suppressed:',
] as const;

export interface BrowserContentMigrationResult {
  copied: number;
  conflicts: number;
}

function migrateKey(
  storage: Storage,
  legacyKey: string,
  scopedKey: string,
  result: BrowserContentMigrationResult,
): void {
  try {
    const legacy = storage.getItem(legacyKey);
    if (legacy === null) return;
    const scoped = storage.getItem(scopedKey);
    if (scoped !== null) {
      if (scoped === legacy) {
        // A previous copy completed but removal was interrupted.
        storage.removeItem(legacyKey);
      } else {
        // Never guess which distinct value is newer. Preserve both for manual
        // recovery instead of silently discarding either side.
        result.conflicts += 1;
      }
      return;
    }
    storage.setItem(scopedKey, legacy);
    if (storage.getItem(scopedKey) === legacy) {
      storage.removeItem(legacyKey);
      result.copied += 1;
    }
  } catch {
    // Leave the legacy key intact when copy/verification fails so a later
    // bootstrap can retry without data loss.
  }
}

/**
 * One-time compatibility move for browser-held pre-workspace content. Legacy
 * values belong to default-workspace only and are never copied into a sibling.
 */
export function migrateLegacyBrowserWorkspaceContent(): BrowserContentMigrationResult {
  const result: BrowserContentMigrationResult = { copied: 0, conflicts: 0 };
  if (typeof window === 'undefined' || getSelectedWorkspace() !== DEFAULT_WORKSPACE) return result;

  for (const key of LEGACY_LOCAL_KEYS) {
    migrateKey(window.localStorage, key, workspaceLocalStorageKey(key), result);
  }
  for (const key of LEGACY_SESSION_KEYS) {
    migrateKey(window.sessionStorage, key, workspaceSessionKey(key), result);
  }

  // MCP App preferences are conversation-keyed, so discover legacy entries by
  // prefix from a stable snapshot before deleting anything.
  try {
    const dynamicKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index),
    ).filter((key): key is string => Boolean(
      key && LEGACY_LOCAL_PREFIXES.some(prefix => key.startsWith(prefix)),
    ));
    for (const key of dynamicKeys) {
      migrateKey(window.localStorage, key, workspacePrefixedStorageKey(key), result);
    }
  } catch {
    /* storage unavailable; static migrations above follow the same retry rule */
  }

  return result;
}
