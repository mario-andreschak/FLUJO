/**
 * In-process dispatcher for FLUJO's built-in MCP servers (issue #170).
 *
 * MCPService routes tools/list and tools/call for a built-in server through this
 * module by server name. Each built-in server owns its own tool module; they are
 * pulled in with dynamic imports (matching internalServerConfig.ts's rationale:
 * the `flujo` dispatcher transitively imports modules that import mcpService back,
 * so a static import from index.ts would close that cycle at module-init time).
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InternalDispatchService } from '../internalTools';
import { INTERNAL_SERVER_NAME } from '../internalServerConfig';
import { FILESYSTEM_SERVER_NAME, BASH_SERVER_NAME } from './registry';

/** Tool definitions for the given built-in server. */
export async function internalToolDefinitionsFor(serverName: string): Promise<Tool[]> {
  switch (serverName) {
    case INTERNAL_SERVER_NAME: {
      const { internalToolDefinitions } = await import('../internalTools');
      return internalToolDefinitions();
    }
    case FILESYSTEM_SERVER_NAME: {
      const { filesystemToolDefinitions } = await import('./filesystemTools');
      return filesystemToolDefinitions();
    }
    case BASH_SERVER_NAME: {
      const { bashToolDefinitions } = await import('./bashTools');
      return bashToolDefinitions();
    }
    default:
      return [];
  }
}

/** Dispatch a tools/call for the given built-in server. Never throws. */
export async function internalCallToolFor(
  service: InternalDispatchService,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (serverName) {
    case INTERNAL_SERVER_NAME: {
      const { internalCallTool } = await import('../internalTools');
      return internalCallTool(service, toolName, args);
    }
    case FILESYSTEM_SERVER_NAME: {
      const { filesystemCallTool } = await import('./filesystemTools');
      return filesystemCallTool(toolName, args);
    }
    case BASH_SERVER_NAME: {
      const { bashCallTool } = await import('./bashTools');
      return bashCallTool(toolName, args);
    }
    default:
      return {
        content: [{ type: 'text', text: `Unknown built-in server: ${serverName}` }],
        isError: true,
      };
  }
}
