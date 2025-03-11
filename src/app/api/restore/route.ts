import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/restore/route');

// Store files in .next directory to ensure they're writable in production
const STORAGE_DIR = path.join(process.cwd(), 'storage');
const MCP_SERVERS_DIR = path.join(process.cwd(), 'mcp-servers');

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
    
    // Ensure storage directory exists
    await ensureDir(STORAGE_DIR);
    
    // Restore storage files
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
          
          // Save the data
          await saveItem(storageKey, data);
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

