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
import type { RestoreSelectionResult } from '@/shared/types/backup';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { v4 as uuidv4 } from 'uuid';
import { restoreFolderFromZipLinkSafe } from '@/backend/services/workspace/backupRestoreFs';
import { withModelCatalogWriteLease } from '@/backend/services/model/catalogAdmission';
import { ModelCatalogBusyError } from '@/backend/services/enduringAgents/runtimeLock';

const log = createLogger('app/api/restore/route');

// Workspaces (#406): restore writes into the SELECTED workspace only. A legacy
// (pre-workspace) archive therefore lands in default-workspace by default,
// which is exactly where its data used to live.
const mcpServersDir = () => path.join(getWorkspaceDataDir(), 'mcp-servers');

interface StorageRestorePlan {
  selection: string;
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
    || Object.prototype.hasOwnProperty.call(value, 'personaTargetId')
    || Object.prototype.hasOwnProperty.call(value, 'personaInstructionContext')
    || value.personaArchived === true
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
    const file = formData.get('file');
    const selectionsJson = formData.get('selections');
    
    if (!file || typeof file === 'string' || typeof selectionsJson !== 'string' || !selectionsJson) {
      log.error(`Missing file or selections [${requestId}]`);
      return NextResponse.json({ error: 'Missing file or selections' }, { status: 400 });
    }
    
    let requestedSelections: unknown;
    try {
      requestedSelections = JSON.parse(selectionsJson);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid selections' }, { status: 400 });
    }
    const selections = Array.isArray(requestedSelections)
      ? [...new Set(requestedSelections.filter((selection): selection is string =>
        typeof selection === 'string' && (selection === 'mcpServersFolder' || storageKeyForSelection(selection) !== undefined)))]
      : [];
    log.debug(`Restore selections [${requestId}]:`, selections);
    
    if (!selections || !Array.isArray(selections) || selections.length === 0) {
      log.error(`Invalid selections [${requestId}]:`, selections);
      return NextResponse.json({ error: 'Invalid selections' }, { status: 400 });
    }
    
    // Read the file as an array buffer
    const fileBuffer = await file.arrayBuffer();
    
    // Load the zip file
    log.debug(`Loading zip file [${requestId}]`);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(fileBuffer);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid backup file' }, { status: 400 });
    }
    
    // Verify backup metadata
    const metadataFile = zip.file('backup-info.json');
    if (!metadataFile) {
      log.error(`Invalid backup file: missing metadata [${requestId}]`);
      return NextResponse.json({ error: 'Invalid backup file: missing metadata' }, { status: 400 });
    }
    
    let metadata: unknown;
    try {
      metadata = JSON.parse(await metadataFile.async('string'));
      if (!isRecord(metadata)) throw new Error('Invalid metadata');
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid backup metadata' }, { status: 400 });
    }
    log.debug(`Backup metadata [${requestId}]:`, metadata);
    const selectionResults: Record<string, RestoreSelectionResult> = Object.fromEntries(
      selections.map(selection => [selection, {
        restored: 0,
        // Partial exports can contain good entries AND omitted records. Keep
        // that evidence even when every surviving entry restores successfully.
        failed: isRecord(metadata) && isRecord(metadata.selectionResults)
          && metadata.selectionResults[selection] === 'failed' ? 1 : 0,
      }]),
    );
    
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
          // Older and credential-omitting archives legitimately lack keys.
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
        if (storageKey === StorageKey.FLOWS && !Array.isArray(data)) {
          throw new Error('Invalid flow collection');
        }
        storageRestorePlan.push({ selection, storageKey, archivePath, data });
      } catch (error) {
        log.error(`Error preflighting restore file [${requestId}]:`, error);
        selectionResults[selection].failed++;
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
            selectionResults.chatHistory.failed++;
            continue;
          }
          const conversationId = relativePath.slice(0, -'.json'.length);
          assertSafeCollectionId(conversationId);
          const parsed: unknown = JSON.parse(await zip.files[entryPath].async('string'));
          if (!isRecord(parsed) || parsed.conversationId !== conversationId) {
            log.warn(`Skipped conversation with mismatched id [${requestId}]:`, entryPath);
            selectionResults.chatHistory.failed++;
            continue;
          }
          assertSafeCollectionId(parsed.conversationId);
          if (isPersonaConversationSnapshot(parsed)) {
            return NextResponse.json(
              { error: 'Persona-attributed conversation snapshots cannot be restored.' },
              { status: 400 },
            );
          }
          conversationRestorePlan.push({ conversationId, conversation: parsed });
        } catch (error) {
          log.error(`Error preflighting conversation [${requestId}] from ${entryPath}:`, error);
          selectionResults.chatHistory.failed++;
        }
      }
      for (const { conversationId } of conversationRestorePlan) {
        // Failure to inspect the destination is an authority failure, not a
        // malformed archive entry that may be skipped before other writes.
        const existing = await loadCollectionItem<Record<string, unknown> | null>('conversations', conversationId, null);
        if (isPersonaConversationSnapshot(existing)) {
          return NextResponse.json(
            { error: 'Restore cannot overwrite an existing Persona conversation.' },
            { status: 409 },
          );
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
    let modelCatalogBusy = false;
    for (const { selection, storageKey, archivePath, data } of storageRestorePlan) {
      try {
        if (storageKey === StorageKey.FLOWS) {
          const flows = data as Flow[];
          for (const flow of flows) {
            try {
              const result = await flowService.saveFlow(flow);
              if (!result.success) {
                selectionResults[selection].failed++;
                log.warn(`Skipped restoring a flow [${requestId}]:`, result.error);
              } else {
                selectionResults[selection].restored++;
              }
            } catch (error) {
              selectionResults[selection].failed++;
              log.error(`Error restoring a flow [${requestId}]:`, error);
            }
          }
        } else if (storageKey === StorageKey.MODELS) {
          await withModelCatalogWriteLease(() => saveItem(storageKey, data));
          selectionResults[selection].restored++;
        } else {
          await saveItem(storageKey, data);
          selectionResults[selection].restored++;
        }
        log.debug(`Restored file [${requestId}]:`, archivePath);
      } catch (error) {
        selectionResults[selection].failed++;
        if (storageKey === StorageKey.MODELS && error instanceof ModelCatalogBusyError) {
          modelCatalogBusy = true;
        }
        log.error(`Error restoring file [${requestId}]:`, error);
      }
    }

    for (const { conversationId, conversation } of conversationRestorePlan) {
      try {
        await saveCollectionItem('conversations', conversationId, conversation);
        selectionResults.chatHistory.restored++;
        log.debug(`Restored conversation [${requestId}]:`, conversationId);
      } catch (error) {
        selectionResults.chatHistory.failed++;
        log.error(`Error restoring conversation [${requestId}]:`, error);
      }
    }

    // Restore MCP servers folder if selected
    if (selections.includes('mcpServersFolder')) {
      const hasFolder = Object.keys(zip.files).some(entryPath => entryPath.startsWith('mcp-servers/'));
      if (hasFolder) {
        try {
          log.debug(`Restoring MCP servers folder [${requestId}]`);
          await restoreFolderFromZipLinkSafe(
            zip,
            'mcp-servers',
            mcpServersDir(),
            getWorkspaceDataDir(),
            (entryPath, reason) => {
              selectionResults.mcpServersFolder.failed++;
              log.warn(`Skipped unsafe MCP restore entry ${entryPath}: ${reason}`);
            },
            { onRestored: () => { selectionResults.mcpServersFolder.restored++; } },
          );
          log.debug(`Restored MCP servers folder [${requestId}]`);
        } catch (error) {
          selectionResults.mcpServersFolder.failed++;
          log.error(`Error restoring MCP servers folder [${requestId}]:`, error);
        }
      }
    }
    const restored = Object.values(selectionResults).reduce((total, result) => total + result.restored, 0);
    const failed = Object.values(selectionResults).reduce((total, result) => total + result.failed, 0);
    const status = failed ? (restored ? 'partial' : 'failed') : (restored ? 'complete' : 'empty');
    log.info(`Restore finished (${status}) [${requestId}]`);
    if (modelCatalogBusy) {
      return NextResponse.json({
        success: false, status, selectionResults,
        error: 'Models were not restored because the catalog is in use by an active model call; retry after it finishes.',
        code: 'MODEL_CATALOG_BUSY',
        partial: true,
      }, { status: 409 });
    }
    return NextResponse.json({ success: status === 'complete', status, selectionResults }, {
      status: status === 'failed' ? 500 : status === 'empty' ? 400 : 200,
    });
  } catch (error) {
    log.error(`Error restoring from backup [${requestId}]:`, error);
    return NextResponse.json({ success: false, error: 'Failed to restore from backup' }, { status: 500 });
  }
}

// Workspaces (#406): restores into the selected workspace only; archive entries
// that would escape it or traverse links are refused by backupRestoreFs.
export const POST = withWorkspaceRoute(POST_handler);

