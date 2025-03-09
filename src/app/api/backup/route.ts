import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/backup/route');

// Store files in .next directory to ensure they're writable in production
const STORAGE_DIR = path.join(process.cwd(), 'storage');
const MCP_SERVERS_DIR = path.join(process.cwd(), 'mcp-servers');

export async function POST(request: NextRequest) {
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
    zip.file('backup-info.json', JSON.stringify({
      version: '1.0',
      timestamp: new Date().toISOString(),
      selections,
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
          const filePath = path.join(STORAGE_DIR, `${storageKey}.json`);
          log.debug(`Reading file for backup [${requestId}]:`, filePath);
          
          // Check if file exists
          try {
            await fs.access(filePath);
          } catch (error) {
            log.warn(`File does not exist [${requestId}]:`, filePath);
            continue;
          }
          
          const content = await fs.readFile(filePath, 'utf-8');
          zip.file(`storage/${storageKey}.json`, content);
          log.debug(`Added file to backup [${requestId}]:`, `storage/${storageKey}.json`);
        } catch (error) {
          log.error(`Error adding file to backup [${requestId}]:`, error);
          // Continue with other files
        }
      }
    }
    
    // Add MCP servers folder if selected
    if (selections.includes('mcpServersFolder')) {
      try {
        log.debug(`Adding MCP servers folder to backup [${requestId}]`);
        await addFolderToZip(zip, MCP_SERVERS_DIR, 'mcp-servers');
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
    return new NextResponse(zipBuffer, {
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
