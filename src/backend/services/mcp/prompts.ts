import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import {
  MCPPrompt,
  MCPGetPromptResult,
  MCPServiceResponse,
} from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/prompts');

/**
 * List the prompt templates a server publishes (prompts/list).
 *
 * Mirrors listServerResources: a missing client yields an empty list + `error`; a server
 * that doesn't implement prompts answers method-not-found, which we surface as an empty
 * list rather than a hard failure.
 */
export async function listServerPrompts(
  client: Client | undefined,
  serverName: string
): Promise<{ prompts: MCPPrompt[]; error?: string }> {
  log.debug('Entering listServerPrompts method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { prompts: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing prompts for server ${serverName}`);
    const response = await client.listPrompts();
    const prompts = (response.prompts || []) as MCPPrompt[];
    return { prompts };
  } catch (error) {
    if (error instanceof McpError && error.code === -32601) {
      log.debug(`Server ${serverName} does not support prompts/list`);
      return { prompts: [] };
    }
    log.warn(`Failed to list prompts for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      prompts: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list prompts: ${errorMessage}`,
    };
  }
}

/**
 * Fetch a prompt template, expanded with the given arguments (prompts/get).
 *
 * Argument values may contain global-variable references (a prompt bound to flow variables
 * at design time), so they are resolved through resolveGlobalVars first — matching callTool.
 */
export async function getPrompt(
  client: Client | undefined,
  serverName: string,
  promptName: string,
  args?: Record<string, string>
): Promise<MCPServiceResponse<MCPGetPromptResult>> {
  log.debug('Entering getPrompt method');
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return { success: false, error: `Server ${serverName} not found`, statusCode: 404 };
  }

  try {
    let resolvedArgs: Record<string, string> | undefined;
    if (args && Object.keys(args).length > 0) {
      const resolved = await resolveGlobalVars(args);
      resolvedArgs =
        typeof resolved === 'object' && resolved !== null
          ? (resolved as Record<string, string>)
          : undefined;
    }

    log.info(`Getting prompt ${promptName} from server ${serverName}`);
    const response = await client.getPrompt({
      name: promptName,
      arguments: resolvedArgs,
    });
    return { success: true, data: response as MCPGetPromptResult };
  } catch (error) {
    log.warn(`Failed to get prompt ${promptName} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let statusCode = 500;

    if (error instanceof McpError) {
      errorMessage = `Failed to get prompt: ${errorMessage} (Code: ${error.code})`;
      if (error.code === -32601) statusCode = 404; // Method not found
      else if (error.code === -32602) statusCode = 400; // Invalid params
    } else {
      errorMessage = `Failed to get prompt: ${errorMessage}`;
    }

    return { success: false, error: errorMessage, statusCode };
  }
}
