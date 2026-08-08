import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { assertSafeCollectionId, listCollectionItems, loadItem } from '@/utils/storage/backend';
import { flowService } from '@/backend/services/flow';
import { StorageKey } from '@/shared/types/';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/backup/route');

// Workspaces (#406): a backup covers exactly ONE workspace — the selected one.
// Aggregating every workspace into a single archive would make restore a
// far more destructive operation than it is today, so that is deliberately out
// of scope here. Resolved per call because the workspace is per-request.
const mcpServersDir = () => path.join(getWorkspaceDataDir(), 'mcp-servers');

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const requestId = uuidv4();
  log.info(`Handling backup request [RequestID: ${requestId}]`);
  
  try {
    const { selections } = await request.json();
    log.debug(`Backup selections [${requestId}]:`, selections);
    
    if (!selections || !Array.isArray(selections) || selections.length === 0) {
      log.error(`Invalid selections [${requestId}]:`, selections);
      return NextResponse.json({ error: 'Invalid selections' }, { status: 400 });
    }
    
    // Create a new zip file
    const zip = new JSZip();
    
    // Add metadata
    // `version` stays '1.0' so older FLUJO builds can still read new archives;
    // the workspace fields are additive metadata that a legacy reader ignores.
    zip.file('backup-info.json', JSON.stringify({
      version: '1.0',
      timestamp: new Date().toISOString(),
      selections,
      // #406: which workspace this archive was taken from, and which on-disk
      // layout it assumes. An archive WITHOUT these fields is a legacy,
      // pre-workspace backup and restores into the selected workspace.
      workspace: getCurrentWorkspace(),
      workspaceLayoutVersion: 1,
    }));
    
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
        case 'encryptionKey':
          storageKey = StorageKey.ENCRYPTION_KEY;
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
            ? await flowService.loadFlows()
            : await loadItem<unknown>(storageKey, null);
          if (data === null || (storageKey === StorageKey.FLOWS && Array.isArray(data) && data.length === 0)) {
            log.warn(`No data stored for key [${requestId}]:`, storageKey);
            continue;
          }
          
          // Keep the zip entry layout storage/<key>.json — restore and
          // previously created backups depend on it.
          zip.file(`storage/${storageKey}.json`, JSON.stringify(data, null, 2));
          log.debug(`Added file to backup [${requestId}]:`, `storage/${storageKey}.json`);
        } catch (error) {
          log.error(`Error adding file to backup [${requestId}]:`, error);
          // Continue with other files
        }
      }
    }
    
    // Modern conversations live one-file-per-conversation. Keep the legacy
    // storage/history.json entry above for backward compatibility, and add the
    // collection snapshots independently so mixed archives preserve both.
    if (selections.includes('chatHistory')) {
      try {
        const conversations = await listCollectionItems<Record<string, unknown>>('conversations');
        for (const conversation of conversations) {
          const conversationId = conversation.conversationId;
          if (typeof conversationId !== 'string') {
            log.warn(`Skipped conversation without an id [${requestId}]`);
            continue;
          }
          try {
            assertSafeCollectionId(conversationId);
            zip.file(
              `storage/conversations/${conversationId}.json`,
              JSON.stringify(conversation, null, 2),
            );
          } catch (error) {
            log.warn(`Skipped conversation with an unsafe id [${requestId}]:`, error);
          }
        }
      } catch (error) {
        log.error(`Error adding conversations to backup [${requestId}]:`, error);
      }
    }

    // Add MCP servers folder if selected
    if (selections.includes('mcpServersFolder')) {
      try {
        log.debug(`Adding MCP servers folder to backup [${requestId}]`);
        await addFolderToZip(zip, mcpServersDir(), 'mcp-servers');
        log.debug(`Added MCP servers folder to backup [${requestId}]`);
      } catch (error) {
        log.error(`Error adding MCP servers folder to backup [${requestId}]:`, error);
        // Continue with other files
      }
    }
    
    // Generate the zip file
    log.debug(`Generating zip file [${requestId}]`);
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 9
      }
    });
    
    log.info(`Backup created successfully [${requestId}]`);
    
    // Return the zip file
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename=flujo-backup.zip'
      }
    });
  } catch (error) {
    log.error(`Error creating backup [${requestId}]:`, error);
    return NextResponse.json({ error: 'Failed to create backup' }, { status: 500 });
  }
}

// Helper function to recursively add a folder to a zip file
async function addFolderToZip(zip: JSZip, folderPath: string, zipPath: string) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const zipEntryPath = path.join(zipPath, entry.name).replace(/\\/g, '/');
    
    if (entry.isDirectory()) {
      // Skip node_modules and .git folders
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      
      // Create folder in zip
      zip.folder(zipEntryPath);
      
      // Recursively add contents
      await addFolderToZip(zip, fullPath, zipEntryPath);
    } else {
      // Skip large files (> 10MB)
      try {
        const stats = await fs.stat(fullPath);
        if (stats.size > 10 * 1024 * 1024) {
          continue;
        }
        
        // Add file to zip
        const content = await fs.readFile(fullPath);
        zip.file(zipEntryPath, content);
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }
  }
}



// Workspaces (#406): the archive contains only the selected workspace's data.
export const POST = withWorkspaceRoute(POST_handler);
