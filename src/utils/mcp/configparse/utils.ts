'use client';

import { FileExistsResult } from './types';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/configparse/utils');

/**
 * Check if a file exists in the repository and optionally read its content
 * @param repoPath Path to the repository
 * @param filePath Path to the file relative to the repository root
 * @param readContent Whether to read the file content if it exists
 */
export async function checkFileExists(
  repoPath: string,
  filePath: string,
  readContent: boolean = false
): Promise<FileExistsResult> {
  try {
    log.debug(`Checking if file exists: ${repoPath}/${filePath}`);
    
    // Construct the path - avoid double slashes if repoPath already ends with a slash
    const fullPath = repoPath.endsWith('/') || repoPath.endsWith('\\') 
      ? `${repoPath}${filePath}` 
      : `${repoPath}/${filePath}`;
    
    log.debug(`Constructed full path: ${fullPath}`);
    
    // Call the server-side API to check if the file exists
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'readFile',
        savePath: fullPath,
      }),
    });
    
    if (!response.ok) {
      log.debug(`File does not exist: ${repoPath}/${filePath}`);
      return { exists: false };
    }
    
    const result = await response.json();
    
    if (!result.content && readContent) {
      log.debug(`File exists but is empty: ${repoPath}/${filePath}`);
      return { exists: true, content: '' };
    }
    
    log.debug(`File exists: ${repoPath}/${filePath}`);
    return { 
      exists: true, 
      content: readContent ? result.content : undefined 
    };
  } catch (error) {
    log.error(`Error checking if file exists: ${repoPath}/${filePath}`, error);
    return { exists: false };
  }
}

/**
 * Read a file from the repository
 * @param repoPath Path to the repository
 * @param filePath Path to the file relative to the repository root
 */
export async function readFile(
  repoPath: string,
  filePath: string
): Promise<string | null> {
  try {
    const result = await checkFileExists(repoPath, filePath, true);
    return result.exists && result.content ? result.content : null;
  } catch (error) {
    log.error(`Error reading file: ${repoPath}/${filePath}`, error);
    return null;
  }
}
