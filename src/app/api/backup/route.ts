import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { assertSafeCollectionId, listCollectionItemEntriesStrict, loadItemForBackup } from '@/utils/storage/backend';
import { flowService } from '@/backend/services/flow';
import { StorageKey } from '@/shared/types/';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { v4 as uuidv4 } from 'uuid';
import { WORKSPACE_LAYOUT_VERSION } from '@/backend/services/workspace/layoutVersion';
import { ordinaryBackupData, ORDINARY_BACKUP_SELECTIONS } from '@/backend/services/workspace/backupExport';

const log = createLogger('app/api/backup/route');

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

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const requestId = uuidv4();
  log.info(`Handling backup request [RequestID: ${requestId}]`);

  try {
    const { selections: requestedSelections } = await request.json();
    const selections = Array.isArray(requestedSelections)
      ? [...new Set(requestedSelections.filter((selection): selection is string =>
        typeof selection === 'string' && (ORDINARY_BACKUP_SELECTIONS as readonly string[]).includes(selection)))]
      : [];

    if (!selections || !Array.isArray(selections) || selections.length === 0) {
      log.error(`Invalid selections [${requestId}]`);
      return NextResponse.json({ error: 'Invalid selections' }, { status: 400 });
    }

    // Freeze the exact chat-history snapshot before constructing an archive.
    // A second read after the authority check would leave a TOCTOU window in
    // which newly Persona-attributed state could enter a non-strict backup.
    let chatHistorySnapshot: unknown = null;
    const selectionResults: Record<string, 'completed' | 'empty' | 'failed'> = Object.fromEntries(selections.map(selection => [selection, 'empty']));
    const conversationSnapshots: Record<string, unknown>[] = [];
    if (selections.includes('chatHistory')) {
      const [historySnapshot, loadedConversations] = await Promise.all([
        loadItemForBackup<unknown>(StorageKey.CHAT_HISTORY, null),
        listCollectionItemEntriesStrict<unknown>('conversations'),
      ]);
      chatHistorySnapshot = historySnapshot;
      for (const { id, item: conversation } of loadedConversations) {
        if (!isRecord(conversation) || typeof conversation.conversationId !== 'string' || conversation.conversationId !== id) {
          log.warn(`Skipped conversation without an id [${requestId}]`);
          selectionResults.chatHistory = 'failed';
          continue;
        }
        try {
          assertSafeCollectionId(conversation.conversationId);
          conversationSnapshots.push(conversation);
        } catch {
          selectionResults.chatHistory = 'failed';
          log.warn(`Skipped conversation with an unsafe id [${requestId}]`);
        }
      }
      const includesPersonaConversation = historyContainsPersonaConversation(chatHistorySnapshot)
        || conversationSnapshots.some(isPersonaConversationSnapshot);
      if (includesPersonaConversation) {
        const notStrictLoopback = assertLocalRequest(request, { strictLoopback: true });
        if (notStrictLoopback) return notStrictLoopback;
      }
    }

    // Create a new zip file
    const zip = new JSZip();

    // Add storage files
    const storageSelections = selections.filter(s => s !== 'mcpServersFolder');
    for (const selection of storageSelections) {
      let storageKey: StorageKey | undefined;

      // Map selection to storage key
      switch (selection) {
        case 'models':
          storageKey = StorageKey.MODELS;
          break;
        case 'mcpServers':
          storageKey = StorageKey.MCP_SERVERS;
          break;
        case 'flows':
          storageKey = StorageKey.FLOWS;
          break;
        case 'chatHistory':
          storageKey = StorageKey.CHAT_HISTORY;
          break;
        case 'settings':
          storageKey = StorageKey.THEME;
          break;
        case 'globalEnvVars':
          storageKey = StorageKey.GLOBAL_ENV_VARS;
          break;
      }

      if (storageKey) {
        try {
          log.debug(`Loading storage item for backup [${requestId}]:`, storageKey);

          // Flows now live one-file-per-flow (db/flows/<id>.json); aggregate
          // them back into the single array the zip format expects so old FLUJO
          // versions can still restore new backups. Everything else reads its
          // single storage file as before.
          const data = storageKey === StorageKey.FLOWS
            ? await flowService.loadFlowsForBackup()
            : storageKey === StorageKey.CHAT_HISTORY
              ? chatHistorySnapshot
            : await loadItemForBackup<unknown>(storageKey, null);
          if (data === null || (storageKey === StorageKey.FLOWS && Array.isArray(data) && data.length === 0)) {
            log.warn(`No data stored for key [${requestId}]:`, storageKey);
            continue;
          }

          // Keep the zip entry layout storage/<key>.json — restore and
          // previously created backups depend on it.
          const serialized = JSON.stringify(ordinaryBackupData(selection, data), null, 2);
          if (serialized === undefined) continue;
          zip.file(`storage/${storageKey}.json`, serialized);
          if (selectionResults[selection] !== 'failed') selectionResults[selection] = Array.isArray(data) && data.length === 0 ? 'empty' : 'completed';
          log.debug(`Added file to backup [${requestId}]:`, `storage/${storageKey}.json`);
        } catch {
          log.error(`Error adding file to backup [${requestId}]`);
          selectionResults[selection] = 'failed';
          // Continue with other files
        }
      }
    }

    // Modern conversations live one-file-per-conversation. Keep the legacy
    // storage/history.json entry above for backward compatibility, and add the
    // collection snapshots independently so mixed archives preserve both.
    if (selections.includes('chatHistory')) {
      for (const conversation of conversationSnapshots) {
        try {
          const conversationId = conversation.conversationId as string;
          zip.file(`storage/conversations/${conversationId}.json`, JSON.stringify(ordinaryBackupData('chatHistory', conversation), null, 2));
          if (selectionResults.chatHistory !== 'failed') selectionResults.chatHistory = 'completed';
        } catch {
          selectionResults.chatHistory = 'failed';
          log.error(`Error adding conversation to backup [${requestId}]`);
        }
      }
    }
    if (Object.values(selectionResults).includes('failed') && !Object.values(zip.files).some(file => !file.dir)) {
      return NextResponse.json({ error: 'Failed to create backup' }, { status: 500 });
    }
    const status = Object.values(selectionResults).includes('failed') ? 'partial' : 'complete';
    // Add metadata
    // `version` stays '1.0' so older FLUJO builds can still read new archives;
    // the workspace fields are additive metadata that a legacy reader ignores.
    zip.file('backup-info.json', JSON.stringify({
      status,
      selectionResults,
      version: '1.0',
      timestamp: new Date().toISOString(),
      selections,
      credentials: 'omitted',
      omittedSelections: ['encryptionKey', 'mcpServersFolder'],
      // #406: which workspace this archive was taken from, and which on-disk
      // layout it assumes. An archive WITHOUT these fields is a legacy,
      // pre-workspace backup and restores into the selected workspace.
      workspace: getCurrentWorkspace(),
      workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION,
    }));


    // Generate the zip file
    log.debug(`Generating zip file [${requestId}]`);
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 9
      }
    });

    log.info(`Backup created (${status}) [${requestId}]`);

    // Return the zip file
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'X-Flujo-Backup-Status': status,
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename=flujo-backup.zip'
      }
    });
  } catch {
    log.error(`Error creating backup [${requestId}]`);
    return NextResponse.json({ error: 'Failed to create backup' }, { status: 500 });
  }
}

// Workspaces (#406): the archive contains only the selected workspace's data.
export const POST = withWorkspaceRoute(POST_handler);
