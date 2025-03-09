'use client';

import { ParsedServerConfig } from "./types";
import { parseServerConfig } from "./parseServerConfig";
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('utils/mcp/parseServerConfigFromClipboard');

/**
 * Parse clipboard content to extract MCP server configuration
 * @param parseEnvVars Whether to parse environment variables (default: true)
 * @param serverName Optional server name to use for path processing
 */
export async function parseServerConfigFromClipboard(parseEnvVars: boolean = true, serverName?: string): Promise<ParsedServerConfig> {
  log.debug('parseServerConfigFromClipboard: Entering method', { parseEnvVars, serverName });
  try {
    const clipboardText = await navigator.clipboard.readText();
    return parseServerConfig(clipboardText, parseEnvVars, serverName);
  } catch (error) {
    log.error('parseServerConfigFromClipboard: Failed to read clipboard:', error);
    return {
      config: {},
      message: {
        type: 'error',
        text: 'Failed to read clipboard content.'
      }
    }
  }
}
