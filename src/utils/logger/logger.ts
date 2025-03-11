// Logger utility
import { FEATURES } from '@/config/features';

export const LOG_LEVEL = {
  VERBOSE: -1, // Most verbose level for extremely detailed logging
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Use the feature flag with a fallback to ERROR level if not set
export const CURRENT_LOG_LEVEL = 
  typeof FEATURES.LOG_LEVEL === 'number' ? FEATURES.LOG_LEVEL : LOG_LEVEL.ERROR;

function logWithLevel(level: number, filepath: string, message: string, data?: any, overrideLogLevel?: number) {
  // Use the override log level if provided, otherwise use the global setting
  const effectiveLogLevel = typeof overrideLogLevel === 'number' ? overrideLogLevel : CURRENT_LOG_LEVEL;
  
  if (level >= effectiveLogLevel) {
    const timestamp = new Date().toISOString();
    const logPrefix = `[${timestamp}] [${filepath}]`;
    
    let output = `${logPrefix} ${message}`;
    if (data !== undefined) {
      if (typeof data === 'object') {
        try {
          const dataStr = JSON.stringify(data, null, 2);
          output += `:\n${dataStr}`;
        } catch (e) {
          output += ': [Object cannot be stringified]';
        }
      } else {
        output += `: ${data}`;
      }
    }

    switch (level) {
      case LOG_LEVEL.VERBOSE:
        console.debug(`[VERBOSE] ${output}`);
        break;
      case LOG_LEVEL.DEBUG:
        console.debug(output);
        break;
      case LOG_LEVEL.INFO:
        console.info(output);
        break;
      case LOG_LEVEL.WARN:
        console.warn(output);
        break;
      case LOG_LEVEL.ERROR:
        console.error(output);
        break;
      default:
        console.log(output);
    }
  }
}

/**
 * Normalizes a file path to ensure consistent logging format
 * Removes src/ prefix if present and ensures proper formatting
 */
export function normalizeFilePath(filepath: string): string {
  // Remove src/ prefix if present
  let normalizedPath = filepath.replace(/^src\//, '');
  
  // Ensure the path has the correct format
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }
  
  return normalizedPath;
}

/**
 * Creates a logger instance with a pre-configured file path
 * This makes it easier to use the logger consistently across the application
 * 
 * @param filepath - The file path to use for logging
 * @param overrideLogLevel - Optional parameter to override the global log level for this logger instance
 */
export function createLogger(filepath: string, overrideLogLevel?: number) {
  const normalizedPath = normalizeFilePath(filepath);
  
  return {
    verbose: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.VERBOSE, normalizedPath, message, data, overrideLogLevel);
    },
    debug: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.DEBUG, normalizedPath, message, data, overrideLogLevel);
    },
    info: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.INFO, normalizedPath, message, data, overrideLogLevel);
    },
    warn: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.WARN, normalizedPath, message, data, overrideLogLevel);
    },
    error: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.ERROR, normalizedPath, message, data, overrideLogLevel);
    }
  };
}
