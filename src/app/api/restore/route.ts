import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import JSZip from 'jszip';
import { assertSafeCollectionId, saveCollectionItem, saveItem } from '@/utils/storage/backend';
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
    
    // Restore storage files (saveItem creates the storage directory itself)
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
        case 'encryptionKey':
          storageKey = StorageKey.ENCRYPTION_KEY;
          break;
      }
      
      if (storageKey) {
        try {
          const zipFile = zip.file(`storage/${storageKey}.json`);
          if (!zipFile) {
            log.warn(`File not found in backup [${requestId}]:`, `storage/${storageKey}.json`);
            continue;
          }
          
          const content = await zipFile.async('string');
          const data = JSON.parse(content);
          
          if (storageKey === StorageKey.FLOWS) {
            // The backup stores flows as a single array (frozen zip format), but
            // flows are now persisted one file per flow. Import each via the
            // service (which validates the id and invalidates caches). This is an
            // upsert; flows already present are overwritten, others are added.
            const flows: Flow[] = Array.isArray(data) ? data : [];
            for (const flow of flows) {
              const result = await flowService.saveFlow(flow);
              if (!result.success) {
                log.warn(`Skipped restoring a flow [${requestId}]:`, result.error);
              }
            }
          } else {
            // Save the data
            await saveItem(storageKey, data);
          }
          log.debug(`Restored file [${requestId}]:`, `storage/${storageKey}.json`);
        } catch (error) {
          log.error(`Error restoring file [${requestId}]:`, error);
          // Continue with other files
        }
      }
    }
    
    // Restore modern conversation snapshots independently from legacy history.
    // Only accept one-level JSON entries with validated ids; archive paths are
    // never joined to the filesystem. Restoration is intentionally upsert-only.
    if (selections.includes('chatHistory')) {
      const conversationPrefix = 'storage/conversations/';
      const conversationEntries = Object.keys(zip.files).filter((entryPath) =>
        entryPath.startsWith(conversationPrefix) &&
        !zip.files[entryPath].dir
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
          const conversation = JSON.parse(await zip.files[entryPath].async('string')) as Record<string, unknown>;
          if (conversation.conversationId !== conversationId) {
            log.warn(`Skipped conversation with mismatched id [${requestId}]:`, entryPath);
            continue;
          }
          assertSafeCollectionId(conversation.conversationId);
          await saveCollectionItem('conversations', conversationId, conversation);
          log.debug(`Restored conversation [${requestId}]:`, conversationId);
        } catch (error) {
          log.error(`Error restoring conversation [${requestId}] from ${entryPath}:`, error);
        }
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

