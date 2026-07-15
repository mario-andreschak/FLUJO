/**
 * Tool definitions + dispatcher for FLUJO's built-in internal MCP server
 * (see internalServerConfig.ts for the identity/loading story).
 *
 * This is the third "FLUJO-as-server" brain next to flowTools.ts (flows-as-tools
 * for external clients) and flowAuthoringTools.ts (FlowSpec authoring): hand-written
 * MCP Tool definitions dispatched straight to the backend services, no process, no
 * transport. Unlike the other two it is consumed by FLUJO's OWN flow engine — a flow
 * binds the server named "flujo" like any other MCP server and its model can then
 * author/inspect/update flows, run flows, manage/install MCP servers, and inspect
 * models, planned executions and chat conversations.
 *
 * Security posture:
 *  - Secrets never reach a model: list_mcp_servers returns name/transport/status
 *    only (no env, headers, or OAuth material); list_models whitelists metadata
 *    fields and never the ApiKey; planned executions expose the trigger TYPE only
 *    (webhook trigger configs carry a secret token).
 *  - Conversation transcripts (read_conversation) exclude system-role messages
 *    (node system prompts are model plumbing, same rule as the chat UI) and are
 *    size-bounded so a long conversation can't flood the calling model's context.
 *  - call_mcp_tool refuses the internal server itself, and execute_flow carries a
 *    process-wide depth guard, so a flow cannot recurse through FLUJO unboundedly.
 *
 * MCPService loads this module via dynamic import only (never statically): the
 * imports below (runFlow, flowAuthoringTools → registryInstall) transitively import
 * mcpService back, and this file must not be pulled into index.ts's module-init.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { killProcessTree } from '@/utils/process/killProcessTree';
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig, MCPServiceResponse, MCPToolResponse } from '@/shared/types/mcp';
import type { SharedState } from '@/backend/execution/flow/types';
import type { Flow } from '@/shared/types/flow';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import {
  flushConversationLog,
  readConversationLog,
  projectMessages,
} from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { getDataDir } from '@/utils/paths';
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

/** terminal tool bounds. Output is capped so a chatty build can't flood the model's context. */
const TERMINAL_DEFAULT_TIMEOUT_MS = 60_000;
const TERMINAL_MAX_TIMEOUT_MS = 600_000;
const TERMINAL_MAX_OUTPUT_CHARS = 100_000;

/** read_conversation bounds (same rationale as the terminal output cap). */
const READ_CONVERSATION_DEFAULT_LIMIT = 50;
const READ_CONVERSATION_MAX_CHARS = 100_000;
const READ_CONVERSATION_TOOL_ARGS_CHARS = 2_000;

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
      name: 'read_flow',
      description:
        'Read a FLUJO flow\'s full definition (by name or id): its nodes with their prompts, bound models, attached MCP servers/tools and input/output modes, plus the control and MCP edges. Note this is the COMPILED flow (node ids, not FlowSpec keys) — to change it, author a fresh FlowSpec and call update_flow.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
        },
        required: ['flow'],
      },
    },
    {
      name: 'update_flow',
      description:
        'REPLACE an existing FLUJO flow\'s definition (by name or id) with a newly compiled FlowSpec, keeping the flow\'s id — so planned executions, subflow nodes and conversations that reference it keep working. The spec format is the same as create_flow/validate_flow_spec (see those tool descriptions); saving is gated on zero validation errors. The replaced definition is archived automatically — list_flow_versions / revert_flow can restore it. Note that manual canvas edits made in the builder are part of what gets replaced. Use read_flow first to see what you are replacing.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id of the flow to replace.' },
          spec: { type: 'object', description: 'The FlowSpec object (see the create_flow tool description for the format).' },
        },
        required: ['flow', 'spec'],
      },
    },
    {
      name: 'list_flow_versions',
      description:
        'List a flow\'s archived versions (by name or id), newest first. A version is created automatically whenever the flow\'s definition is overwritten (builder save, update_flow, revert_flow) and holds the definition that was replaced. Use read_flow_version to inspect one and revert_flow to restore one.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
        },
        required: ['flow'],
      },
    },
    {
      name: 'read_flow_version',
      description:
        'Read one archived version of a flow (see list_flow_versions): the full definition it held before it was replaced, in the same format as read_flow.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
          version: { type: 'string', description: 'The version id (see list_flow_versions).' },
        },
        required: ['flow', 'version'],
      },
    },
    {
      name: 'revert_flow',
      description:
        'Restore an archived version (see list_flow_versions) as the flow\'s CURRENT definition. The definition being reverted away from is archived first, so a revert can itself be undone. References by flow id keep working.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id.' },
          version: { type: 'string', description: 'The version id to restore (see list_flow_versions).' },
        },
        required: ['flow', 'version'],
      },
    },
    {
      name: 'delete_flow',
      description:
        'PERMANENTLY delete a FLUJO flow (by name or id). This cannot be undone — the flow\'s version history is deleted with it. Verify the target with list_flow_building_blocks first.',
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
    {
      name: 'list_conversations',
      description:
        'List the chat conversations stored in this FLUJO instance (id, title, bound flow, status, created/updated timestamps), newest first. Use read_conversation to get a transcript.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Optional maximum number of conversations to return (newest first). Default: all.' },
        },
      },
    },
    {
      name: 'read_conversation',
      description:
        'Read one chat conversation\'s transcript by conversation id (see list_conversations). Returns the displayed messages: system prompts are excluded, nested subflow steps carry a "depth" marker, assistant tool calls are summarized. Long conversations return only the most recent messages — raise "limit" to get more.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation: { type: 'string', description: 'The conversation id.' },
          limit: {
            type: 'number',
            description: `Maximum number of most-recent messages to return (default ${READ_CONVERSATION_DEFAULT_LIMIT}). The total transcript size is capped regardless.`,
          },
        },
        required: ['conversation'],
      },
    },
    {
      name: 'terminal',
      description:
        'Run a shell command on the FLUJO host and return its combined stdout/stderr plus exit code. Runs through a shell, so pipes and chained commands (e.g. "npm install && npm run build") work. Use it to install dependencies, build a cloned MCP server, inspect the filesystem, or run diagnostics. Working directory defaults to the FLUJO data directory (where cloned servers live under mcp-servers/); pass "cwd" to run elsewhere. The command is killed if it exceeds the timeout, and very large output is truncated.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command line to execute, e.g. "npm install && npm run build".' },
          cwd: {
            type: 'string',
            description:
              'Optional working directory. Relative paths resolve against the FLUJO data directory. Defaults to the data directory.',
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in seconds (default 60, max 600). The command is killed if it runs longer.',
          },
        },
        required: ['command'],
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

/**
 * A flow definition in inspectable form. Canvas trivia (positions, handle ids,
 * edge ids/styles) is dropped; the derived `mcpNodes` blob on process
 * properties is dropped too (FlowConverter regenerates it — it must never
 * round-trip through an author). Everything semantic stays: prompts, bound
 * models, attached servers/tools, input/output modes, edges. Shared by
 * read_flow and read_flow_version.
 */
function formatFlowDefinition(flow: Flow): Record<string, unknown> {
  const nodes = flow.nodes.map((node) => {
    const { mcpNodes: _derived, ...properties } = (node.data?.properties ?? {}) as Record<string, unknown>;
    return {
      id: node.id,
      type: node.type,
      label: node.data?.label,
      ...(node.data?.description ? { description: node.data.description } : {}),
      properties,
    };
  });
  const edges = flow.edges.map((edge) => {
    const data = edge.data as { edgeType?: string; bidirectional?: boolean } | undefined;
    return {
      from: edge.source,
      to: edge.target,
      type: data?.edgeType === 'mcp' ? 'mcp' : 'control',
      ...(data?.bidirectional ? { bidirectional: true } : {}),
    };
  });
  return {
    id: flow.id,
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    nodes,
    edges,
  };
}

async function readFlow(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}". Use list_flow_building_blocks to see the available flows.` }, true);
  }
  return textResult({
    ...formatFlowDefinition(flow),
    note: 'This is the compiled flow (node ids, not FlowSpec keys). To change it, author a fresh FlowSpec and call update_flow — it replaces the whole definition while keeping this flow id.',
  });
}

async function listFlowVersionsTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}".` }, true);
  }
  const versions = await flowService.listFlowVersions(flow.id);
  return textResult({
    flowId: flow.id,
    flowName: flow.name,
    versions,
    ...(versions.length === 0
      ? { note: 'No archived versions yet — versions appear once the flow\'s definition is overwritten for the first time.' }
      : {}),
  });
}

async function readFlowVersion(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  const versionId = String(args?.version ?? '').trim();
  if (!ref || !versionId) {
    return textResult({ error: 'Provide "flow" (name or id) and "version" (see list_flow_versions).' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}".` }, true);
  }
  const record = await flowService.getFlowVersion(flow.id, versionId);
  if (!record) {
    return textResult({ error: `No version "${versionId}" of flow "${flow.name}". Use list_flow_versions to see the archived versions.` }, true);
  }
  return textResult({
    versionId: record.versionId,
    savedAt: record.savedAt,
    ...formatFlowDefinition(record.flow),
  });
}

async function revertFlowTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  const versionId = String(args?.version ?? '').trim();
  if (!ref || !versionId) {
    return textResult({ error: 'Provide "flow" (name or id) and "version" (see list_flow_versions).' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}".` }, true);
  }
  const result = await flowService.revertFlow(flow.id, versionId);
  if (!result.success) {
    return textResult({ error: result.error ?? `Failed to revert flow "${flow.name}".` }, true);
  }
  return textResult({
    reverted: true,
    flowId: flow.id,
    versionId,
    note: 'The definition that was just replaced has been archived too, so this revert can itself be undone via list_flow_versions / revert_flow.',
  });
}

/** Tolerate the spec arriving as an object or a JSON string (same as the authoring tools). */
function extractSpecArg(args: Record<string, unknown>): unknown {
  const raw = args?.spec;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw ?? null;
}

async function updateFlow(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "flow": the name or id of the flow to replace.' }, true);
  }
  const spec = extractSpecArg(args);
  if (!spec) {
    return textResult({ error: 'Provide a "spec" argument: a FlowSpec object (or a JSON string of one).' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}". Use list_flow_building_blocks to see the available flows.` }, true);
  }

  const result = await compileSpec(spec, { save: true, updateFlowId: flow.id });
  if (!result.success) {
    return textResult({ error: result.error, issues: result.issues ?? [] }, true);
  }
  const summary = {
    flowId: result.flow.id,
    flowName: result.flow.name,
    nodeCount: result.flow.nodes.length,
    edgeCount: result.flow.edges.length,
    validation: result.validation,
    saved: result.saved,
    ...(result.saved
      ? { note: `Flow "${result.flow.name}" was replaced (id ${result.flow.id} kept — existing references keep working).` }
      : { note: 'NOT saved: validation found errors. The existing flow is unchanged. Fix the issues and call update_flow again.' }),
  };
  // An update that could not save is an error outcome for the caller's loop.
  return textResult(summary, !result.saved);
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
 * List stored conversations as light summaries. Reads the conversation snapshot
 * files directly (same source as GET /v1/chat/conversations) instead of loading
 * full states through the executor: only metadata fields go out, never messages.
 */
async function listConversations(args: Record<string, unknown>): Promise<CallToolResult> {
  const conversationsDir = path.join(getDataDir(), 'db', 'conversations');
  let files: string[];
  try {
    files = await fs.readdir(conversationsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return textResult([]); // no conversations yet
    }
    return textResult({ error: `Failed to list conversations: ${err instanceof Error ? err.message : String(err)}` }, true);
  }

  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(conversationsDir, file), 'utf-8');
          const state = JSON.parse(raw) as SharedState;
          const id = state.conversationId || file.replace(/\.json$/, '');
          // Same stale-'running' reconcile as the conversations list route: a
          // process restart drops the live run without flipping the stored
          // status, and such a run can never resume.
          let status = state.status;
          if (status === 'running' && executionEventBus.currentSeq(id) === 0) {
            status = 'error';
          }
          return {
            id,
            title: state.title || 'Untitled Conversation',
            flowId: state.flowId || null,
            ...(status ? { status } : {}),
            createdAt: state.createdAt || 0,
            updatedAt: state.updatedAt || 0,
          };
        } catch (err) {
          log.warn(`list_conversations: skipping unreadable conversation file ${file}`, err);
          return null;
        }
      })
  );

  const valid = summaries
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  return textResult(limit ? valid.slice(0, limit) : valid);
}

/**
 * Compact one transcript message for model consumption: role/content/timestamp
 * plus depth for nested subflow steps; assistant tool calls are reduced to
 * name + (truncated) arguments, tool results keep their call id for matching.
 */
function compactMessage(msg: FlujoChatMessage): Record<string, unknown> {
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  const out: Record<string, unknown> = {
    role: msg.role,
    ...(content ? { content } : {}),
    ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
    ...(msg.depth ? { depth: msg.depth } : {}),
  };

  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    out.toolCalls = msg.tool_calls.map((tc) => {
      const fn = 'function' in tc ? tc.function : undefined;
      const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
      return {
        id: tc.id,
        ...(fn?.name ? { name: fn.name } : {}),
        ...(args !== undefined
          ? {
              arguments:
                args.length > READ_CONVERSATION_TOOL_ARGS_CHARS
                  ? args.slice(0, READ_CONVERSATION_TOOL_ARGS_CHARS) + '…[truncated]'
                  : args,
            }
          : {}),
      };
    });
  }
  if (msg.role === 'tool' && msg.tool_call_id) {
    out.toolCallId = msg.tool_call_id;
  }
  return out;
}

/**
 * Read one conversation's transcript. Same message-resolution order as
 * GET /v1/chat/conversations/{id}: flush + project the append-only conversation
 * log (carries subflow depth, never contains node system prompts), falling back
 * to the snapshot's messages minus system-role ones for pre-log conversations.
 * Newest messages win the size budget: the transcript is trimmed from the front.
 */
async function readConversation(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = String(args?.conversation ?? '').trim();
  if (!id) {
    return textResult({ error: 'Provide "conversation": a conversation id (see list_conversations).' }, true);
  }

  await flushConversationLog(id);
  const state = await loadConversationState(id);
  if (!state) {
    return textResult({ error: `No conversation with id "${id}". Use list_conversations to see the stored conversations.` }, true);
  }

  const events = await readConversationLog(id);
  const projected = events ? projectMessages(events) : [];
  const all =
    projected.length > 0
      ? projected
      : (state.messages || []).filter((msg) => msg.role !== 'system');

  const limit =
    typeof args?.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : READ_CONVERSATION_DEFAULT_LIMIT;

  // Walk backwards so the newest messages always make it into the budget; the
  // first (newest) message is always included even if it alone exceeds the cap.
  const selected: Array<Record<string, unknown>> = [];
  let usedChars = 0;
  for (let i = all.length - 1; i >= 0 && selected.length < limit; i--) {
    const compact = compactMessage(all[i]);
    const size = JSON.stringify(compact).length;
    if (selected.length > 0 && usedChars + size > READ_CONVERSATION_MAX_CHARS) break;
    selected.push(compact);
    usedChars += size;
  }
  selected.reverse();

  return textResult({
    id: state.conversationId || id,
    title: state.title || 'Untitled Conversation',
    flowId: state.flowId || null,
    ...(state.status ? { status: state.status } : {}),
    createdAt: state.createdAt || 0,
    updatedAt: state.updatedAt || 0,
    totalMessages: all.length,
    ...(selected.length < all.length
      ? { note: `Returning the ${selected.length} most recent of ${all.length} messages — raise "limit" to get more.` }
      : {}),
    messages: selected,
  });
}

/**
 * Run a shell command on the host and return its combined output + exit code.
 *
 * Mirrors the spawn semantics of the LocalServerTab backend (app/api/git/route.ts
 * streamCommandInRepo): `shell: true` so compound commands work, full process env
 * inherited, output buffered (capped) instead of streamed since a CallToolResult is
 * a single response. Unlike the git route this is not tied to a cloned repo — the
 * cwd defaults to the writable data dir. Arbitrary command execution is deliberate:
 * this server is localhost-only + encryption-lock gated, and already installs/runs
 * arbitrary registry packages via install_mcp_server.
 */
async function runTerminal(args: Record<string, unknown>): Promise<CallToolResult> {
  const command = String(args?.command ?? '').trim();
  if (!command) {
    return textResult({ error: 'Provide "command": a shell command line to run.' }, true);
  }

  const dataDir = getDataDir();
  const rawCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
  const cwd = rawCwd ? (path.isAbsolute(rawCwd) ? rawCwd : path.join(dataDir, rawCwd)) : dataDir;

  const timeoutSec = typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : TERMINAL_DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = Math.min(timeoutSec * 1000, TERMINAL_MAX_TIMEOUT_MS);

  return await new Promise<CallToolResult>((resolve) => {
    let output = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const append = (chunk: string) => {
      if (truncated) return;
      output += chunk;
      if (output.length > TERMINAL_MAX_OUTPUT_CHARS) {
        output = output.slice(0, TERMINAL_MAX_OUTPUT_CHARS) + '\n…[output truncated]';
        truncated = true;
      }
    };

    let child;
    // POSIX: spawn detached so the shell wrapper is a process-group leader and
    // killProcessTree can signal the whole group on timeout. Windows uses
    // taskkill /T by pid, so no detached flag is needed there.
    const detached = process.platform !== 'win32';
    try {
      child = spawn(command, { cwd, shell: true, env: process.env, detached });
    } catch (err) {
      resolve(textResult({ error: `Failed to start command: ${err instanceof Error ? err.message : String(err)}`, cwd }, true));
      return;
    }

    // On timeout, kill the ENTIRE process tree (not just the shell wrapper) so
    // grandchildren the shell launched are not left orphaned/running. Keep the
    // returned escalation-cleanup so finish() can cancel the pending SIGKILL.
    let cancelEscalation: (() => void) | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      cancelEscalation = killProcessTree(child);
    }, timeoutMs);

    const finish = (result: CallToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelEscalation?.();
      resolve(result);
    };

    child.stdout?.on('data', (d: Buffer) => append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => append(d.toString()));

    child.on('error', (err: Error) => {
      append(`\n${err.message}`);
      finish(textResult({ error: `Command failed to start: ${err.message}`, cwd, output }, true));
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        finish(textResult({ timedOut: true, cwd, exitCode: code, output: `${output}\n[killed after ${timeoutMs / 1000}s timeout]` }, true));
        return;
      }
      finish(textResult({ exitCode: code, cwd, output }, code !== 0));
    });
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
      case 'read_flow':
        return await readFlow(args);
      case 'update_flow':
        return await updateFlow(args);
      case 'list_flow_versions':
        return await listFlowVersionsTool(args);
      case 'read_flow_version':
        return await readFlowVersion(args);
      case 'revert_flow':
        return await revertFlowTool(args);
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
      case 'list_conversations':
        return await listConversations(args);
      case 'read_conversation':
        return await readConversation(args);
      case 'terminal':
        return await runTerminal(args);
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
