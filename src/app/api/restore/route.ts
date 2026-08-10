import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import JSZip from 'jszip';
import {
  assertSafeCollectionId,
  loadCollectionItem,
  loadItem,
  saveCollectionItem,
  saveItem,
} from '@/utils/storage/backend';
import { flowService } from '@/backend/services/flow';
import { StorageKey } from '@/shared/types/storage';
import type { Flow } from '@/shared/types/flow';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { v4 as uuidv4 } from 'uuid';
import { restoreFolderFromZipLinkSafe } from '@/backend/services/workspace/backupRestoreFs';

const log = createLogger('app/api/restore/route');

// Workspaces (#406): restore writes into the SELECTED workspace only. A legacy
// (pre-workspace) archive therefore lands in default-workspace by default,
// which is exactly where its data used to live.
const mcpServersDir = () => path.join(getWorkspaceDataDir(), 'mcp-servers');

interface StorageRestorePlan {
  storageKey: StorageKey;
  archivePath: string;
  data: unknown;
}

interface ConversationRestorePlan {
  conversationId: string;
  conversation: Record<string, unknown>;
}

function storageKeyForSelection(selection: unknown): StorageKey | undefined {
  switch (selection) {
    case 'models': return StorageKey.MODELS;
    case 'mcpServers': return StorageKey.MCP_SERVERS;
    case 'flows': return StorageKey.FLOWS;
    case 'chatHistory': return StorageKey.CHAT_HISTORY;
    case 'settings': return StorageKey.THEME;
    case 'globalEnvVars': return StorageKey.GLOBAL_ENV_VARS;
    case 'encryptionKey': return StorageKey.ENCRYPTION_KEY;
    default: return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersonaConversationSnapshot(value: unknown): boolean {
  return isRecord(value) && (
    Object.prototype.hasOwnProperty.call(value, 'personaAttribution')
    || value.personaOwned === true
  );
}

function historyContainsPersonaConversation(value: unknown): boolean {
  return isPersonaConversationSnapshot(value)
    || (Array.isArray(value) && value.some(isPersonaConversationSnapshot));
}

function conversationIdsInHistory(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.conversationId === 'string'
      ? entry.conversationId
      : typeof entry.id === 'string'
        ? entry.id
        : undefined;
    if (id) ids.add(id);
  }
  return [...ids];
}

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const requestId = uuidv4();
  log.info(`Handling restore request [RequestID: ${requestId}]`);
  
  try {
    // Parse the multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const selectionsJson = formData.get('selections') as string | null;
    
    if (!file || !selectionsJson) {
      log.error(`Missing file or selections [${requestId}]`);
      return NextResponse.json({ error: 'Missing file or selections' }, { status: 400 });
    }
    
    const selections = JSON.parse(selectionsJson);
    log.debug(`Restore selections [${requestId}]:`, selections);
    
    if (!selections || !Array.isArray(selections) || selections.length === 0) {
      log.error(`Invalid selections [${requestId}]:`, selections);
      return NextResponse.json({ error: 'Invalid selections' }, { status: 400 });
    }
    
    // Read the file as an array buffer
    const fileBuffer = await file.arrayBuffer();
    
    // Load the zip file
    log.debug(`Loading zip file [${requestId}]`);
    const zip = await JSZip.loadAsync(fileBuffer);
    
    // Verify backup metadata
    const metadataFile = zip.file('backup-info.json');
    if (!metadataFile) {
      log.error(`Invalid backup file: missing metadata [${requestId}]`);
      return NextResponse.json({ error: 'Invalid backup file: missing metadata' }, { status: 400 });
    }
    
    const metadata = JSON.parse(await metadataFile.async('string'));
    log.debug(`Backup metadata [${requestId}]:`, metadata);
    
    // Build a complete, immutable restore plan before the first write. This is
    // the safety transaction boundary: a Persona-owned entry found late in the
    // archive rejects the whole request instead of leaving earlier keys saved.
    const storageRestorePlan: StorageRestorePlan[] = [];
    const storageSelections = selections.filter((selection) => selection !== 'mcpServersFolder');
    for (const selection of storageSelections) {
      const storageKey = storageKeyForSelection(selection);
      if (!storageKey) continue;
      const archivePath = `storage/${storageKey}.json`;
      try {
        const zipFile = zip.file(archivePath);
        if (!zipFile) {
          log.warn(`File not found in backup [${requestId}]:`, archivePath);
          continue;
        }
        const data: unknown = JSON.parse(await zipFile.async('string'));
        if (
          storageKey === StorageKey.CHAT_HISTORY
          && historyContainsPersonaConversation(data)
        ) {
          return NextResponse.json(
            { error: 'Persona-attributed conversation history cannot be restored.' },
            { status: 400 },
          );
        }
        storageRestorePlan.push({ storageKey, archivePath, data });
      } catch (error) {
        log.error(`Error preflighting restore file [${requestId}]:`, error);
        // Preserve the existing tolerant archive semantics for malformed or
        // missing non-Persona entries, while still performing no writes yet.
      }
    }

    const conversationRestorePlan: ConversationRestorePlan[] = [];
    if (selections.includes('chatHistory')) {
      const conversationPrefix = 'storage/conversations/';
      const conversationEntries = Object.keys(zip.files).filter((entryPath) =>
        entryPath.startsWith(conversationPrefix)
        && !zip.files[entryPath].dir
      );
      for (const entryPath of conversationEntries) {
        try {
          const relativePath = entryPath.slice(conversationPrefix.length);
          if (!relativePath.endsWith('.json') || relativePath.includes('/')) {
            log.warn(`Skipped unsafe conversation archive entry [${requestId}]:`, entryPath);
            continue;
          }
          const conversationId = relativePath.slice(0, -'.json'.length);
          assertSafeCollectionId(conversationId);
          const parsed: unknown = JSON.parse(await zip.files[entryPath].async('string'));
          if (!isRecord(parsed) || parsed.conversationId !== conversationId) {
            log.warn(`Skipped conversation with mismatched id [${requestId}]:`, entryPath);
            continue;
          }
          assertSafeCollectionId(parsed.conversationId);
          if (isPersonaConversationSnapshot(parsed)) {
            return NextResponse.json(
              { error: 'Persona-attributed conversation snapshots cannot be restored.' },
              { status: 400 },
            );
          }
          const existing = await loadCollectionItem<Record<string, unknown> | null>(
            'conversations',
            conversationId,
            null,
          );
          if (isPersonaConversationSnapshot(existing)) {
            return NextResponse.json(
              { error: 'Restore cannot overwrite an existing Persona conversation.' },
              { status: 409 },
            );
          }
          conversationRestorePlan.push({ conversationId, conversation: parsed });
        } catch (error) {
          log.error(`Error preflighting conversation [${requestId}] from ${entryPath}:`, error);
        }
      }
    }

    if (storageRestorePlan.some(({ storageKey }) => storageKey === StorageKey.CHAT_HISTORY)) {
      const existingHistory = await loadItem<unknown>(StorageKey.CHAT_HISTORY, null);
      if (historyContainsPersonaConversation(existingHistory)) {
        return NextResponse.json(
          { error: 'Restore cannot overwrite existing Persona conversation history.' },
          { status: 409 },
        );
      }
      const importedHistory = storageRestorePlan.find(
        ({ storageKey }) => storageKey === StorageKey.CHAT_HISTORY,
      )?.data;
      for (const conversationId of conversationIdsInHistory(importedHistory)) {
        try {
          assertSafeCollectionId(conversationId);
        } catch {
          continue;
        }
        const existing = await loadCollectionItem<Record<string, unknown> | null>(
          'conversations',
          conversationId,
          null,
        );
        if (isPersonaConversationSnapshot(existing)) {
          return NextResponse.json(
            { error: 'Restore cannot overwrite an existing Persona conversation.' },
            { status: 409 },
          );
        }
      }
    }

    // Persona safety preflight is complete; ordinary tolerant restore semantics
    // begin only after this point.
    for (const { storageKey, archivePath, data } of storageRestorePlan) {
      try {
        if (storageKey === StorageKey.FLOWS) {
          const flows: Flow[] = Array.isArray(data) ? data : [];
          for (const flow of flows) {
            const result = await flowService.saveFlow(flow);
            if (!result.success) {
              log.warn(`Skipped restoring a flow [${requestId}]:`, result.error);
            }
          }
        } else {
          await saveItem(storageKey, data);
        }
        log.debug(`Restored file [${requestId}]:`, archivePath);
      } catch (error) {
        log.error(`Error restoring file [${requestId}]:`, error);
      }
    }

    for (const { conversationId, conversation } of conversationRestorePlan) {
      try {
        await saveCollectionItem('conversations', conversationId, conversation);
        log.debug(`Restored conversation [${requestId}]:`, conversationId);
      } catch (error) {
        log.error(`Error restoring conversation [${requestId}]:`, error);
      }
    }

    // Restore MCP servers folder if selected
    if (selections.includes('mcpServersFolder')) {
      try {
        log.debug(`Restoring MCP servers folder [${requestId}]`);
        await restoreFolderFromZipLinkSafe(
          zip,
          'mcp-servers',
          mcpServersDir(),
          getWorkspaceDataDir(),
          (entryPath, reason) => log.warn(`Skipped unsafe MCP restore entry ${entryPath}: ${reason}`),
        );
        log.debug(`Restored MCP servers folder [${requestId}]`);
      } catch (error) {
        log.error(`Error restoring MCP servers folder [${requestId}]:`, error);
        // Continue with other files
      }
    }
    
    log.info(`Restore completed successfully [${requestId}]`);
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error(`Error restoring from backup [${requestId}]:`, error);
    return NextResponse.json({ error: 'Failed to restore from backup' }, { status: 500 });
  }
}

// Workspaces (#406): restores into the selected workspace only; archive entries
// that would escape it or traverse links are refused by backupRestoreFs.
export const POST = withWorkspaceRoute(POST_handler);

