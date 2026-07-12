/**
 * Tool definitions + dispatcher for FLUJO's built-in internal MCP server
 * (see internalServerConfig.ts for the identity/loading story).
 *
 * This is the third "FLUJO-as-server" brain next to flowTools.ts (flows-as-tools
 * for external clients) and flowAuthoringTools.ts (FlowSpec authoring): hand-written
 * MCP Tool definitions dispatched straight to the backend services, no process, no
 * transport. Unlike the other two it is consumed by FLUJO's OWN flow engine — a flow
 * binds the server named "flujo" like any other MCP server and its model can then
 * author flows, run flows, manage/install MCP servers, and inspect models and
 * planned executions.
 *
 * Security posture:
 *  - Secrets never reach a model: list_mcp_servers returns name/transport/status
 *    only (no env, headers, or OAuth material); list_models whitelists metadata
 *    fields and never the ApiKey; planned executions expose the trigger TYPE only
 *    (webhook trigger configs carry a secret token).
 *  - call_mcp_tool refuses the internal server itself, and execute_flow carries a
 *    process-wide depth guard, so a flow cannot recurse through FLUJO unboundedly.
 *
 * MCPService loads this module via dynamic import only (never statically): the
 * imports below (runFlow, flowAuthoringTools → registryInstall) transitively import
 * mcpService back, and this file must not be pulled into index.ts's module-init.
 */
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig, MCPServiceResponse, MCPToolResponse } from '@/shared/types/mcp';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { runFlow } from '@/backend/execution/flow/runFlow';
import {
  authoringToolDefinitions,
  authoringCallTool,
  isAuthoringTool,
} from './flowAuthoringTools';
import { INTERNAL_SERVER_NAME } from './internalServerConfig';

const log = createLogger('backend/services/mcp/internalTools');

/**
 * A flow calling execute_flow can start a flow that itself calls execute_flow.
 * The counter is process-global (same rationale as __mcp_clients: several module
 * instances of this file can coexist across Next.js bundles) and bounds that
 * recursion instead of letting it run away.
 */
declare global {
  // eslint-disable-next-line no-var
  var __flujo_internal_flow_depth: number | undefined;
}
const MAX_EXECUTE_FLOW_DEPTH = 4;

/**
 * The slice of MCPService the dispatcher needs. Passed in by the caller instead
 * of importing the singleton, so this module never re-enters index.ts and tests
 * can hand in a plain mock.
 */
export interface InternalDispatchService {
  loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse>;
  getServerStatus(serverName: string): Promise<{ status: string; message?: string }>;
  listServerTools(serverName: string): Promise<{ tools: MCPToolResponse[]; error?: string }>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number
  ): Promise<MCPServiceResponse>;
  forceReconnect(serverName: string): Promise<MCPServiceResponse>;
  updateServerConfig(
    serverName: string,
    updates: Partial<MCPServerConfig>
  ): Promise<MCPServerConfig | MCPServiceResponse>;
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function internalToolDefinitions(): Tool[] {
  return [
    // FlowSpec authoring + marketplace acquisition, shared verbatim with the
    // external /mcp-flows endpoint (list_flow_building_blocks, validate_flow_spec,
    // create_flow, search_mcp_marketplace, install_mcp_server).
    ...authoringToolDefinitions(),
    {
      name: 'execute_flow',
      description:
        'Run another FLUJO flow (by name or id) with the given input and return its final output. The run is ephemeral (no chat conversation is created). Use list_flow_building_blocks to see the available flows. Nested runs are limited in depth — a flow cannot recurse through itself indefinitely.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
          input: { type: 'string', description: 'The message to send to the flow as the user turn.' },
        },
        required: ['flow', 'input'],
      },
    },
    {
      name: 'delete_flow',
      description:
        'PERMANENTLY delete a FLUJO flow (by name or id). This cannot be undone. Verify the target with list_flow_building_blocks first.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
        },
        required: ['flow'],
      },
    },
    {
      name: 'list_mcp_servers',
      description:
        'List the MCP servers configured in this FLUJO instance with their transport, enabled/disabled state and live connection status. Config details (env vars, headers, credentials) are never included.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_mcp_server_tools',
      description:
        'List the tools of one configured MCP server (name, description, input schema). Use together with call_mcp_tool for servers that are not bound to this flow.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The FLUJO server name (see list_mcp_servers).' },
        },
        required: ['server'],
      },
    },
    {
      name: 'call_mcp_tool',
      description:
        'Call a tool on any configured MCP server by server name + tool name. This lets you use servers that are not bound to the current flow. Check the tool\'s input schema with list_mcp_server_tools first.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The FLUJO server name.' },
          tool: { type: 'string', description: 'The tool name on that server.' },
          args: { type: 'object', description: 'Arguments for the tool (per its input schema).' },
          timeout: { type: 'number', description: 'Optional timeout in seconds.' },
        },
        required: ['server', 'tool'],
      },
    },
    {
      name: 'restart_mcp_server',
      description:
        'Force-reconnect a configured MCP server (tears the connection down and rebuilds it). Useful when a server is in an error state after a config or environment change.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The FLUJO server name.' },
        },
        required: ['server'],
      },
    },
    {
      name: 'set_mcp_server_enabled',
      description:
        'Enable or disable a configured MCP server. Disabling disconnects it and prevents any further use; enabling connects it.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The FLUJO server name.' },
          enabled: { type: 'boolean', description: 'true to enable + connect, false to disable + disconnect.' },
        },
        required: ['server', 'enabled'],
      },
    },
    {
      name: 'list_models',
      description:
        'List the models configured in this FLUJO instance (id, name, display name, description, provider, base URL, context window). API keys are never included. Reference models by id or name in FlowSpecs.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_planned_executions',
      description:
        'List the planned (scheduled/triggered) executions in this FLUJO instance with their trigger type, enabled state, armed status and last run outcome.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'run_planned_execution',
      description:
        'Fire a planned execution immediately (by id, see list_planned_executions) and return the run record with its output.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The planned execution id.' },
        },
        required: ['id'],
      },
    },
  ];
}

/** Resolve a flow by id first (exact), then by name. */
async function resolveFlow(ref: string) {
  const flows = await flowService.loadFlows();
  return flows.find((f) => f.id === ref) ?? flows.find((f) => f.name === ref);
}

async function executeFlow(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}". Use list_flow_building_blocks to see the available flows.` }, true);
  }

  const depth = global.__flujo_internal_flow_depth ?? 0;
  if (depth >= MAX_EXECUTE_FLOW_DEPTH) {
    return textResult(
      { error: `execute_flow nesting limit (${MAX_EXECUTE_FLOW_DEPTH}) reached — refusing to start "${flow.name}" to prevent runaway recursion.` },
      true
    );
  }

  global.__flujo_internal_flow_depth = depth + 1;
  try {
    const result = await runFlow({
      flowId: flow.id,
      prompt: String(args?.input ?? ''),
      mode: 'ephemeral',
      flujo: true,
      requireApproval: false,
    });
    if (result.flowNotFound) {
      return textResult({ error: `Flow not found: ${result.flowNotFound.name}` }, true);
    }
    if (result.status === 'error') {
      return textResult({ error: result.error?.message ?? 'Unknown error during flow execution.' }, true);
    }
    return textResult(result.outputText ?? '');
  } finally {
    global.__flujo_internal_flow_depth = depth;
  }
}

async function deleteFlow(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}".` }, true);
  }
  const result = await flowService.deleteFlow(flow.id);
  if (!result.success) {
    return textResult({ error: result.error ?? `Failed to delete flow "${flow.name}".` }, true);
  }
  return textResult({ deleted: true, flowId: flow.id, flowName: flow.name });
}

async function listMcpServers(service: InternalDispatchService): Promise<CallToolResult> {
  const configs = await service.loadServerConfigs();
  if (!Array.isArray(configs)) {
    return textResult({ error: configs.error ?? 'Failed to load server configs.' }, true);
  }
  const servers = await Promise.all(
    configs.map(async (config) => {
      let status = 'unknown';
      try {
        status = (await service.getServerStatus(config.name)).status;
      } catch (err) {
        log.debug(`list_mcp_servers: getServerStatus failed for ${config.name}`, err);
      }
      return {
        name: config.name,
        transport: config.transport,
        enabled: !config.disabled,
        status,
        ...(config.builtIn ? { builtIn: true } : {}),
      };
    })
  );
  return textResult(servers);
}

async function listMcpServerTools(
  service: InternalDispatchService,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = String(args?.server ?? '').trim();
  if (!server) {
    return textResult({ error: 'Provide "server": a FLUJO server name.' }, true);
  }
  if (server === INTERNAL_SERVER_NAME) {
    return textResult(
      internalToolDefinitions().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    );
  }
  const { tools, error } = await service.listServerTools(server);
  if (error) {
    return textResult({ error }, true);
  }
  return textResult(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
}

async function callMcpTool(
  service: InternalDispatchService,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = String(args?.server ?? '').trim();
  const tool = String(args?.tool ?? '').trim();
  if (!server || !tool) {
    return textResult({ error: 'Provide "server" and "tool".' }, true);
  }
  if (server === INTERNAL_SERVER_NAME) {
    return textResult(
      { error: `"${INTERNAL_SERVER_NAME}" is this server — call its tools directly instead of through call_mcp_tool.` },
      true
    );
  }
  const toolArgs =
    args?.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {};
  const timeout = typeof args?.timeout === 'number' ? args.timeout : undefined;

  const result = await service.callTool(server, tool, toolArgs, timeout);
  if (!result.success) {
    return textResult({ error: result.error ?? `Tool call failed on ${server}.` }, true);
  }
  // The downstream CallToolResult passes through untouched (same as the /mcp-proxy
  // forwarding), so content types and isError semantics are preserved.
  const data = result.data as CallToolResult | undefined;
  if (data && Array.isArray(data.content)) {
    return data;
  }
  return textResult(data ?? { ok: true });
}

async function restartMcpServer(
  service: InternalDispatchService,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = String(args?.server ?? '').trim();
  if (!server) {
    return textResult({ error: 'Provide "server": a FLUJO server name.' }, true);
  }
  if (server === INTERNAL_SERVER_NAME) {
    return textResult({ ok: true, note: `"${INTERNAL_SERVER_NAME}" is the built-in server — it is always running.` });
  }
  const result = await service.forceReconnect(server);
  if (!result.success) {
    return textResult({ error: result.error ?? `Failed to restart ${server}.` }, true);
  }
  const status = await service.getServerStatus(server);
  return textResult({ restarted: true, server, status: status.status });
}

async function setMcpServerEnabled(
  service: InternalDispatchService,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = String(args?.server ?? '').trim();
  const enabled = args?.enabled;
  if (!server || typeof enabled !== 'boolean') {
    return textResult({ error: 'Provide "server" (string) and "enabled" (boolean).' }, true);
  }
  if (server === INTERNAL_SERVER_NAME) {
    return textResult({ error: `The built-in "${INTERNAL_SERVER_NAME}" server cannot be disabled.` }, true);
  }
  const result = await service.updateServerConfig(server, { disabled: !enabled });
  if ('error' in result) {
    return textResult({ error: result.error }, true);
  }
  return textResult({ server, enabled });
}

async function listModels(): Promise<CallToolResult> {
  const models = await modelService.loadModels();
  // Strict whitelist: model configs carry the (encrypted) ApiKey, which must never
  // reach a model's context. Only inert metadata goes out.
  return textResult(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    }))
  );
}

async function listPlannedExecutions(): Promise<CallToolResult> {
  const entries = await getSchedulerService().list();
  // Trigger configs are reduced to their TYPE: webhook triggers carry a secret
  // token, and none of the other trigger details are needed to pick a run target.
  return textResult(
    entries.map(({ execution, status, lastRun }) => ({
      id: execution.id,
      name: execution.name,
      enabled: execution.enabled,
      flowId: execution.flowId,
      triggerType: execution.trigger?.type,
      armed: status?.armed ?? false,
      ...(lastRun
        ? {
            lastRun: {
              status: lastRun.status,
              firedAt: lastRun.firedAt,
              ...(lastRun.error ? { error: lastRun.error } : {}),
            },
          }
        : {}),
    }))
  );
}

async function runPlannedExecution(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = String(args?.id ?? '').trim();
  if (!id) {
    return textResult({ error: 'Provide "id": a planned execution id (see list_planned_executions).' }, true);
  }
  const { record, error } = await getSchedulerService().runNow(id);
  if (error || !record) {
    return textResult({ error: error ?? 'Run failed.' }, true);
  }
  return textResult({
    runId: record.runId,
    status: record.status,
    firedAt: record.firedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.outputText ? { outputText: record.outputText } : {}),
    ...(record.error ? { error: record.error } : {}),
  });
}

/**
 * Dispatch one internal-server tool call. Always resolves to a CallToolResult
 * (errors become isError results, mirroring how a real MCP server responds).
 */
export async function internalCallTool(
  service: InternalDispatchService,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    if (isAuthoringTool(toolName)) {
      return await authoringCallTool(toolName, args);
    }
    switch (toolName) {
      case 'execute_flow':
        return await executeFlow(args);
      case 'delete_flow':
        return await deleteFlow(args);
      case 'list_mcp_servers':
        return await listMcpServers(service);
      case 'list_mcp_server_tools':
        return await listMcpServerTools(service, args);
      case 'call_mcp_tool':
        return await callMcpTool(service, args);
      case 'restart_mcp_server':
        return await restartMcpServer(service, args);
      case 'set_mcp_server_enabled':
        return await setMcpServerEnabled(service, args);
      case 'list_models':
        return await listModels();
      case 'list_planned_executions':
        return await listPlannedExecutions();
      case 'run_planned_execution':
        return await runPlannedExecution(args);
      default:
        return textResult({ error: `Unknown tool on the built-in FLUJO server: ${toolName}` }, true);
    }
  } catch (err) {
    log.error('internalCallTool failed', { toolName, err });
    return textResult(
      { error: `Tool failed: ${err instanceof Error ? err.message : String(err)}` },
      true
    );
  }
}
