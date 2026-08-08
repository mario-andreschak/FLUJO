import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
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
        await restoreFolderFromZip(zip, 'mcp-servers', mcpServersDir());
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

// Helper function to ensure a directory exists
async function ensureDir(dir: string) {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Resolve an archive-relative path against the restore target, refusing any
 * entry that would land outside it.
 *
 * Archive entry names are attacker-controlled data: `../../db/encryption_key`
 * or an absolute path inside a hand-crafted zip would otherwise escape the
 * restore target. With workspaces (#406) that escape is strictly worse than
 * before, because "outside the target" now includes OTHER WORKSPACES and the
 * shared parent data root. Returns null for an entry that must be skipped.
 */
function safeJoinInside(targetPath: string, relativePath: string): string | null {
  // Zip paths always use '/', regardless of the platform that produced them.
  if (relativePath.split('/').some(segment => segment === '..')) return null;
  const resolvedTarget = path.resolve(targetPath);
  const resolved = path.resolve(resolvedTarget, ...relativePath.split('/'));
  const rel = path.relative(resolvedTarget, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// Helper function to recursively restore a folder from a zip file
async function restoreFolderFromZip(zip: JSZip, zipPath: string, targetPath: string) {
  // Ensure the target directory exists
  await ensureDir(targetPath);
  
  // Get all files in the zip folder
  const files = Object.keys(zip.files)
    .filter(key => key.startsWith(`${zipPath}/`) && key !== `${zipPath}/`)
    .map(key => ({
      path: key,
      isDirectory: zip.files[key].dir,
      relativePath: key.substring(zipPath.length + 1)
    }));
  
  // Process directories first
  for (const file of files.filter(f => f.isDirectory)) {
    if (!file.relativePath) continue;
    
    const dirPath = safeJoinInside(targetPath, file.relativePath);
    if (!dirPath) {
      log.warn('Skipped unsafe archive directory entry:', file.path);
      continue;
    }
    await ensureDir(dirPath);
  }
  
  // Then process files
  for (const file of files.filter(f => !f.isDirectory)) {
    if (!file.relativePath) continue;
    
    const filePath = safeJoinInside(targetPath, file.relativePath);
    if (!filePath) {
      log.warn('Skipped unsafe archive file entry:', file.path);
      continue;
    }
    const content = await zip.files[file.path].async('nodebuffer');
    
    // Ensure parent directory exists
    const parentDir = path.dirname(filePath);
    await ensureDir(parentDir);
    
    // Write the file
    await fs.writeFile(filePath, content);
  }
}

// Workspaces (#406): restores into the selected workspace only; archive entries
// that would escape it are refused above.
export const POST = withWorkspaceRoute(POST_handler);

