'use client';

import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('utils/mcp/processPathLikeArgument');

/**
 * Process path-like arguments to handle special path patterns
 * @param arg The argument string to process
 * @param serverName Optional server name to strip from the path
 * @returns The processed argument string
 */
export function processPathLikeArgument(arg: string, serverName?: string): string {
  log.debug('processPathLikeArgument: Entering method', { arg, serverName });
  // Skip processing if the argument doesn't look like a path
  if (!arg || typeof arg !== 'string' || (!arg.includes('/') && !arg.includes('\\'))) {
    return arg;
  }

  log.debug(`processPathLikeArgument: Processing argument: ${arg}`);
  
  // Define patterns to match path indicators
  const pathPatterns = [
    '/path/to',
    'PATH_TO',
    'path/to',
    'PATH/TO',
    '/PATH/TO',
    '/PATH_TO',
    'path_to'
  ];
  
  let result = arg;
  
  // Check if the argument contains any of the path patterns
  for (const pattern of pathPatterns) {
    const index = result.indexOf(pattern);
    if (index !== -1) {
      // Strip everything from the beginning until the end of the pattern
      result = result.substring(index + pattern.length);
      log.debug(`processPathLikeArgument: Stripped path pattern "${pattern}": ${result}`);
      break;
    }
  }
  
  // Use the provided server name to strip from the path
  if (serverName && result.includes(serverName)) {
    // More robust check - handle cases where server name appears in path
    const serverPattern = new RegExp(`(^|[\\/\\\\])${serverName}([\\/\\\\]|$)`);
    if (serverPattern.test(result)) {
      result = result.replace(serverPattern, '$1$2');
      log.debug(`processPathLikeArgument: Removed server name "${serverName}": ${result}`);
      
      // Clean up any double slashes that might have been created
      result = result.replace(/\/\//g, '/');
    }
  }
  
  // If the argument now starts with a /, remove that
  if (result.startsWith('/') || result.startsWith('\\')) {
    result = result.substring(1);
    log.debug(`processPathLikeArgument: Removed leading slash: ${result}`);
  }
  
  // If it's completely empty now, fill with "."
  if (!result) {
    result = '.';
    log.debug(`processPathLikeArgument: Empty result, replaced with "."`);
  }
  
  log.debug(`processPathLikeArgument: Final result: ${result}`);
  return result;
}
