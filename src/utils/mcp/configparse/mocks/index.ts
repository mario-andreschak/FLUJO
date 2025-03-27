import { jest } from '@jest/globals';
import type { FileExistsResult } from '../types';

/**
 * Creates a mock file system for testing.
 * 
 * @param files Record of file paths to content or boolean existence flags
 * @returns Mock file system with checkFileExists and readFile methods
 */
export function mockFileSystem(files: Record<string, string | boolean>) {
  return {
    checkFileExists: jest.fn(async (_repoPath: string, filePath: string, readContent = false) => {
      const content = files[filePath];
      if (content === undefined) return { exists: false };
      return {
        exists: true,
        content: readContent && typeof content === 'string' ? content : undefined
      } as FileExistsResult;
    }),
    readFile: jest.fn(async (_repoPath: string, filePath: string) => {
      const content = files[filePath];
      return typeof content === 'string' ? content : null;
    })
  };
}

/**
 * Creates a mock logger for testing.
 * 
 * @returns Mock logger with debug, info, warn, and error methods
 */
export const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as const; 