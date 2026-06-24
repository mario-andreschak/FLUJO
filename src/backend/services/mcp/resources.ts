import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import {
  MCPResource,
  MCPResourceTemplate,
  MCPReadResourceResult,
  MCPServiceResponse,
} from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/resources');

/**
 * List the static resources a server publishes (resources/list).
 *
 * Mirrors listServerTools: a missing client yields an empty list + an `error` string
 * rather than throwing, so a disconnected server degrades gracefully instead of stripping
 * a node's bound resources. Servers that don't advertise the resources capability answer
 * with a "Method not found" error, which we surface as an empty list (not a hard failure).
 */
export async function listServerResources(
  client: Client | undefined,
  serverName: string
): Promise<{ resources: MCPResource[]; error?: string }> {
  log.debug('Entering listServerResources method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { resources: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing resources for server ${serverName}`);
    const response = await client.listResources();
    const resources = (response.resources || []) as MCPResource[];
    log.verbose('Processed resources:', resources);
    return { resources };
  } catch (error) {
    // A server that doesn't implement resources answers with method-not-found (-32601).
    // That's not an error condition for FLUJO — the server simply has no resources.
    if (error instanceof McpError && error.code === -32601) {
      log.debug(`Server ${serverName} does not support resources/list`);
      return { resources: [] };
    }
    log.warn(`Failed to list resources for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      resources: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list resources: ${errorMessage}`,
    };
  }
}

/**
 * List the resource templates a server publishes (resources/templates/list).
 * Templates are parameterized URIs (RFC 6570) the caller fills in at read time.
 */
export async function listServerResourceTemplates(
  client: Client | undefined,
  serverName: string
): Promise<{ resourceTemplates: MCPResourceTemplate[]; error?: string }> {
  log.debug('Entering listServerResourceTemplates method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { resourceTemplates: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing resource templates for server ${serverName}`);
    const response = await client.listResourceTemplates();
    const resourceTemplates = (response.resourceTemplates || []) as MCPResourceTemplate[];
    return { resourceTemplates };
  } catch (error) {
    if (error instanceof McpError && error.code === -32601) {
      log.debug(`Server ${serverName} does not support resources/templates/list`);
      return { resourceTemplates: [] };
    }
    log.warn(`Failed to list resource templates for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      resourceTemplates: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list resource templates: ${errorMessage}`,
    };
  }
}

/**
 * Read a resource's contents (resources/read).
 *
 * `uri` may contain global-variable references (e.g. for a template URI bound to a flow
 * variable at design time), so it is resolved through resolveGlobalVars first — matching
 * how callTool resolves variables in its arguments.
 */
export async function readResource(
  client: Client | undefined,
  serverName: string,
  uri: string
): Promise<MCPServiceResponse<MCPReadResourceResult>> {
  log.debug('Entering readResource method');
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return { success: false, error: `Server ${serverName} not found`, statusCode: 404 };
  }

  try {
    const resolvedUri = (await resolveGlobalVars(uri)) as string;
    log.info(`Reading resource ${resolvedUri} from server ${serverName}`);
    const response = await client.readResource({ uri: resolvedUri });
    return { success: true, data: response as MCPReadResourceResult };
  } catch (error) {
    log.warn(`Failed to read resource ${uri} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let statusCode = 500;

    if (error instanceof McpError) {
      errorMessage = `Failed to read resource: ${errorMessage} (Code: ${error.code})`;
      if (error.code === -32601) statusCode = 404; // Method not found
      else if (error.code === -32602) statusCode = 400; // Invalid params
    } else {
      errorMessage = `Failed to read resource: ${errorMessage}`;
    }

    return { success: false, error: errorMessage, statusCode };
  }
}
