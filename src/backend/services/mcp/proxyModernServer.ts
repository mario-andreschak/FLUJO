import {
  createMcpHandler, ProtocolError, Server,
  type CallToolResult, type ListToolsResult, type ServerCapabilities, type ServerContext,
} from '@modelcontextprotocol/server';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_SKILLS_EXTENSION_ID,
  McpGetSkillRequestSchema,
  McpListSkillsRequestSchema,
  McpReadSkillDirectoryRequestSchema,
  type McpSkillsExtensionCapability,
} from '@/shared/types/mcp';
import { MCP_APPS_EXTENSION_ID } from './appsProtocol';
import { MODERN_MCP_BODY_LIMIT } from './mcpEraRouting';
import {
  proxyCallTool,
  proxyGetSkill,
  proxyListResources,
  proxyListResourceTemplates,
  proxyListSkills,
  proxyListTools,
  proxyReadResource,
  proxyReadSkillDirectory,
} from './proxyForward';

export interface ProxyCapabilities {
  skillsCapability?: McpSkillsExtensionCapability;
  appsCapability?: Record<string, unknown>;
}

/** Downstream protocol errors keep their JSON-RPC code and data for the outer client. */
async function forwardErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof McpError) throw new ProtocolError(error.code, error.message, error.data);
    throw error;
  }
}

function progressReporter(ctx: ServerContext) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (progress: { progress: number; total?: number; message?: string }) => {
    void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
  };
}

/**
 * Serve one 2026-07-28 request for `/mcp-proxy/<server>`: the same tools,
 * resources, Skills and Apps forwarding as the classic proxy server, through
 * the official split SDK (stateless, per-request envelope, routing headers).
 * The route keeps older clients on its classic server.
 */
export async function handleModernProxyMcpRequest(
  request: Request,
  serverName: string,
  version: string,
  { skillsCapability, appsCapability }: ProxyCapabilities,
): Promise<Response> {
  const extensions = {
    ...(appsCapability ? { [MCP_APPS_EXTENSION_ID]: appsCapability } : {}),
    ...(skillsCapability ? { [MCP_SKILLS_EXTENSION_ID]: skillsCapability } : {}),
  } as NonNullable<ServerCapabilities['extensions']>;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: `flujo-proxy-${serverName}`, version }, {
      capabilities: { tools: {}, resources: {}, ...(Object.keys(extensions).length > 0 ? { extensions } : {}) },
    });
    server.setRequestHandler('tools/list', async req =>
      await forwardErrors(() => proxyListTools(serverName, req.params?.cursor)) as ListToolsResult);
    server.setRequestHandler('tools/call', async (req, ctx) => {
      const onProgress = progressReporter(ctx);
      const result = await forwardErrors(() => proxyCallTool(serverName, req.params.name, req.params.arguments ?? {}, {
        signal: AbortSignal.any([ctx.mcpReq.signal, request.signal]),
        ...(onProgress ? { onProgress } : {}),
      }));
      return server.projectCallToolResult(result as CallToolResult, undefined);
    });
    server.setRequestHandler('resources/list', req => forwardErrors(() => proxyListResources(serverName, req.params?.cursor)));
    server.setRequestHandler('resources/templates/list', req =>
      forwardErrors(() => proxyListResourceTemplates(serverName, req.params?.cursor)));
    server.setRequestHandler('resources/read', req => forwardErrors(() => proxyReadResource(serverName, req.params.uri)));
    if (skillsCapability) {
      server.setRequestHandler('skills/list', { params: McpListSkillsRequestSchema.shape.params }, params =>
        forwardErrors(() => proxyListSkills(serverName, params?.cursor)));
      server.setRequestHandler('skills/get', { params: McpGetSkillRequestSchema.shape.params }, params =>
        forwardErrors(() => proxyGetSkill(serverName, params.uri)));
      if (skillsCapability.directoryRead === true) {
        server.setRequestHandler('resources/directory/read', { params: McpReadSkillDirectoryRequestSchema.shape.params }, params =>
          forwardErrors(() => proxyReadSkillDirectory(serverName, params.uri, params.cursor)));
      }
    }
    return server;
  }, { legacy: 'reject', maxRequestBodySize: MODERN_MCP_BODY_LIMIT });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close();
  }
}
