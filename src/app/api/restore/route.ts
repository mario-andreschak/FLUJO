import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { saveItem } from '@/utils/storage/backend';
import { flowService } from '@/backend/services/flow';
import { StorageKey } from '@/shared/types/storage';
import type { Flow } from '@/shared/types/flow';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/restore/route');

const MCP_SERVERS_DIR = path.join(getDataDir(), 'mcp-servers');

export async function POST(request: NextRequest) {
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
    
    // Restore MCP servers folder if selected
    if (selections.includes('mcpServersFolder')) {
      try {
        log.debug(`Restoring MCP servers folder [${requestId}]`);
        await restoreFolderFromZip(zip, 'mcp-servers', MCP_SERVERS_DIR);
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
    
    const dirPath = path.join(targetPath, file.relativePath);
    await ensureDir(dirPath);
  }
  
  // Then process files
  for (const file of files.filter(f => !f.isDirectory)) {
    if (!file.relativePath) continue;
    
    const filePath = path.join(targetPath, file.relativePath);
    const content = await zip.files[file.path].async('nodebuffer');
    
    // Ensure parent directory exists
    const parentDir = path.dirname(filePath);
    await ensureDir(parentDir);
    
    // Write the file
    await fs.writeFile(filePath, content);
  }
}

