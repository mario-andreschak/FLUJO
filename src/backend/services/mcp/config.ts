import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPServiceResponse, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/config');

// Transports that connect to a hosted endpoint (no local process). Their rootPath is
// only used by FLUJO's own file/git features (folder pickers, ServerCard actions,
// git-update route), so a filesystem-root value is never a sensible scope.
const REMOTE_TRANSPORTS = new Set(['streamable', 'sse', 'websocket']);

/**
 * Is this rootPath a bare filesystem root ('/', '\', or a drive root like 'C:\')?
 * Remote server configs created before issue 52 defaulted to '/', which silently
 * pointed folder pickers and git actions at the filesystem root.
 */
function isFilesystemRootPath(rootPath: unknown): boolean {
  if (typeof rootPath !== 'string') return false;
  const trimmed = rootPath.trim();
  return trimmed === '/' || trimmed === '\\' || /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

/**
 * Load MCP server configurations from storage
 */
export async function loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
  log.debug('Entering loadServerConfigs method');
  try {
    const mcpServers = await loadItem<Record<string, any>>(StorageKey.MCP_SERVERS, {});
    
    return Object.entries(mcpServers).map(([name, serverConfig]) => {
      // Determine the transport type
      const transport = serverConfig.transport || 'stdio';

      // Read-time normalization (issue 52): remote servers saved with a too-wide
      // rootPath default ('/'/drive root) are re-pointed at their per-server folder,
      // matching the stdio convention. Idempotent, not persisted back to storage;
      // deliberately narrow so a user's custom rootPath is never touched.
      if (REMOTE_TRANSPORTS.has(transport) && isFilesystemRootPath(serverConfig.rootPath)) {
        log.info(`Normalizing filesystem-root rootPath "${serverConfig.rootPath}" of remote server ${name} to mcp-servers/${name}`);
        serverConfig = { ...serverConfig, rootPath: `mcp-servers/${name}` };
      }
      
      // Default values for any missing properties
      const defaults = {
        name,
        disabled: false,
        autoApprove: [],
        rootPath: '',
        env: {},
        _buildCommand: '',
        _installCommand: ''
      };
      
      if (transport === 'streamable') {
        // Create streamable config with defaults.
        // IMPORTANT: Do NOT default object-typed transport options (requestInit,
        // reconnectionOptions, sessionId, authProvider) to empty strings. The MCP SDK
        // expects these to be proper objects (or undefined). Empty strings get spread
        // into the internal fetch() call and cause a generic "fetch failed" error.
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          // Only carry these through if they are actually present; otherwise leave undefined
          requestInit: serverConfig.requestInit && typeof serverConfig.requestInit === 'object'
            ? serverConfig.requestInit
            : undefined,
          reconnectionOptions: serverConfig.reconnectionOptions && typeof serverConfig.reconnectionOptions === 'object'
            ? serverConfig.reconnectionOptions
            : undefined,
          sessionId: serverConfig.sessionId || undefined,
          // OAuth configuration fields
          oauthClientId: serverConfig.oauthClientId || '',
          oauthClientSecret: serverConfig.oauthClientSecret || '',
          oauthScopes: serverConfig.oauthScopes || (serverConfig.oauthClientId || serverConfig.oauthClientInformation ? ['read'] : undefined),
          // Stored OAuth data
          oauthClientMetadata: serverConfig.oauthClientMetadata,
          oauthClientInformation: serverConfig.oauthClientInformation,
          oauthTokens: serverConfig.oauthTokens,
          oauthCodeVerifier: serverConfig.oauthCodeVerifier
        } as MCPStreamableConfig;


      } else if (transport === 'sse') {
        // Create sse config with defaults.
        // Same as streamable: object-typed options must not default to empty strings.
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          eventSourceInit: serverConfig.eventSourceInit && typeof serverConfig.eventSourceInit === 'object'
            ? serverConfig.eventSourceInit
            : undefined,
          requestInit: serverConfig.requestInit && typeof serverConfig.requestInit === 'object'
            ? serverConfig.requestInit
            : undefined
        } as MCPSSEConfig;


      } else if (transport === 'websocket') {
        // Create WebSocket config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          websocketUrl: serverConfig.websocketUrl || ''
        } as MCPWebSocketConfig;


      } else {
        // Create Stdio config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          command: serverConfig.command || '',
          args: serverConfig.args || [],
          stderr: serverConfig.stderr || 'pipe'
        } as MCPStdioConfig;
      }
    });
  } catch (error) {
    log.warn('Failed to load server configs', error);
    return {
      success: false,
      error: `Failed to load server configs: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Save MCP server configurations to storage
 */
export async function saveConfig(configs: Map<string, MCPServerConfig>): Promise<MCPServiceResponse> {
  log.debug('Entering saveConfig method');
  try {
    const mcpServers = Object.fromEntries(
      Array.from(configs.entries())
        // The built-in internal server is synthesized at load time
        // (MCPService.loadServerConfigs), so callers that load-modify-save the whole
        // set naturally carry it here. Dropping it keeps it out of storage — it must
        // never be persisted or it would stop being synthetic.
        .filter(([, config]) => config.builtIn !== true)
        .map(([name, config]) => {
        // Remove the name property since it's used as the key
        const { name: _, ...configWithoutName } = config;
        
        // Return the entry with the server name as the key
        return [name, configWithoutName];
      })
    );

    await saveItem(StorageKey.MCP_SERVERS, mcpServers);
    return { success: true };
  } catch (error) {
    log.warn('Failed to save config', error);
    return {
      success: false,
      error: `Failed to save config: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}
