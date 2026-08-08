/**
 * Tool definitions + dispatcher for FLUJO's control-plane MCP package.
 *
 * This is the third "FLUJO-as-server" brain next to flowTools.ts (flows-as-tools
 * for external clients) and flowAuthoringTools.ts (FlowSpec authoring): hand-written
 * MCP Tool definitions served through the standalone package's ordinary stdio
 * connection. A flow can bind any persisted record for that package and its model can
 * author/inspect/update flows, run flows, manage/install MCP servers, and inspect
 * models, planned executions and chat conversations.
 *
 * Security posture:
 *  - Secrets never reach a model: list_mcp_servers returns name/transport/status
 *    only (no env, headers, or OAuth material); list_models whitelists metadata
 *    fields and never the ApiKey; planned executions expose the trigger TYPE only
 *    (webhook trigger configs carry a secret token) — and the create/update
 *    planned-execution tools apply the same trigger-type redaction on the way OUT
 *    (a minted webhook token is never echoed back) and clamp flow-driven schedule
 *    changes to a minimum interval so a runaway flow can't set itself to a
 *    every-second cadence.
 *  - Conversation transcripts (read_conversation) exclude system-role messages
 *    (node system prompts are model plumbing, same rule as the chat UI) and are
 *    size-bounded so a long conversation can't flood the calling model's context.
 *  - execute_flow carries a process-wide depth guard, so a flow cannot recurse
 *    through FLUJO unboundedly.
 *  - kv_get/kv_set expose the persistent key-value store (${kv:NAME}). Values are
 *    PLAINTEXT and never secrets (secrets stay in ${global:} / encrypted env);
 *    kv_set clamps to the value cap and both default to the 'global' board (they
 *    have no flow context — a flow-folder board is targeted by passing its scope
 *    id explicitly).
 *
 * MCPService loads this module via dynamic import only (never statically): the
 * imports below (runFlow, flowAuthoringTools → registryInstall) transitively import
 * mcpService back, and this file must not be pulled into index.ts's module-init.
 */
import { createLogger } from '@/utils/logger';
import { AsyncLocalStorage } from 'async_hooks';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig, MCPServiceResponse, MCPToolResponse } from '@/shared/types/mcp';
import type { ToolCallSource, ToolListAudience } from './appsProtocol';
import type { ToolCallProgress } from './tools';
import type { SharedState } from '@/backend/execution/flow/types';
import {
  systemScreenshotToolDefinition,
  systemScreenshotHandler,
} from './systemScreenshot';
import type { Flow } from '@/shared/types/flow';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { scheduleNextRuns } from '@/backend/services/scheduler/triggers/schedule';
import type { PlannedExecution, TriggerConfig } from '@/shared/types/plannedExecution';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { explainCompiledFlow } from '@/backend/services/flow/explainFlow';
import { truncate, MAX_FLOW_DESCRIPTION_CHARS } from '@/backend/services/flow/generationContext';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import {
  flushConversationLog,
  readConversationLog,
  projectMessages,
} from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { kvGet, kvSet } from '@/backend/services/kvStore';
import { ticketService } from '@/backend/services/ticket';
import { CreateTicketInputSchema } from '@/backend/services/ticket/schema';
import {
  listConversationSummaries,
  type ConversationSummary,
} from '@/backend/execution/flow/conversationSummaryStore';
import {
  listInputSchema,
  listOutputSchema,
  ListArgumentError,
  optionalBoolean,
  optionalFiniteNumber,
  optionalString,
  optionalStringArray,
  pagedCallToolResult,
  paginateList,
  parseListArgs,
} from './listQuery';
import {
  matchesPlannedExecutionSearch,
  matchesPlannedExecutionStatus,
  sortPlannedExecutions,
  type PlannedExecutionFilter,
  type PlannedExecutionSortOption,
} from '@/utils/shared/plannedExecutionGrouping';
import {
  authoringToolDefinitions,
  authoringCallTool,
  isAuthoringTool,
} from './flowAuthoringTools';

const log = createLogger('backend/services/mcp/internalTools');

/**
 * A flow calling execute_flow can start a flow that itself calls execute_flow.
 * The counter is process-global (same rationale as __mcp_clients: several module
 * instances of this file can coexist across Next.js bundles) and bounds that
 * recursion instead of letting it run away.
 */
declare global {
  var __flujo_internal_flow_depth: number | undefined;
  var __flujo_internal_flow_depth_als: AsyncLocalStorage<number> | undefined;
}
const MAX_EXECUTE_FLOW_DEPTH = 4;

function internalFlowDepthStore(): AsyncLocalStorage<number> {
  return global.__flujo_internal_flow_depth_als ??
    (global.__flujo_internal_flow_depth_als = new AsyncLocalStorage<number>());
}


/** read_conversation bounds (same rationale as the terminal output cap). */
const READ_CONVERSATION_DEFAULT_LIMIT = 50;
const READ_CONVERSATION_MAX_CHARS = 100_000;
const READ_CONVERSATION_TOOL_ARGS_CHARS = 2_000;

const FLOW_SORTS = ['name-asc', 'name-desc', 'updated-desc', 'updated-asc', 'nodes-desc', 'nodes-asc'] as const;
const FLOW_VERSION_SORTS = ['saved-desc', 'saved-asc'] as const;
const SERVER_SORTS = ['name-asc', 'name-desc', 'status', 'transport'] as const;
const TOOL_SORTS = ['name-asc', 'name-desc'] as const;
const MODEL_SORTS = ['name-asc', 'name-desc', 'provider', 'context-desc', 'context-asc'] as const;
const PLANNED_EXECUTION_SORTS = ['name-asc', 'name-desc', 'newest', 'oldest', 'last-run'] as const;
const CONVERSATION_SORTS = ['activity-desc', 'activity-asc', 'created-desc', 'created-asc', 'title-asc', 'title-desc'] as const;
const CONVERSATION_STATUSES = [
  'not_started',
  'running',
  'awaiting_tool_approval',
  'paused_debug',
  'completed',
  'error',
  'capped',
] as const;
const MCP_SERVER_STATUSES = [
  'connected',
  'disconnected',
  'error',
  'connecting',
  'initialization',
  'requires_authentication',
  'unknown',
] as const;
const MCP_TRANSPORTS = ['stdio', 'websocket', 'sse', 'streamable'] as const;
const PLANNED_EXECUTION_STATES = ['enabled', 'disabled', 'running', 'attention'] as const;
const TRIGGER_TYPES = ['schedule', 'webhook', 'file-watch', 'mcp-poll', 'url-watch', 'flow-event'] as const;
const RUN_STATUSES = ['completed', 'error', 'skipped', 'needs_approval', 'capped'] as const;

/**
 * Runaway-cadence guardrail (issue #112). Flow-driven create/update of a planned
 * execution clamps the effective firing interval to this floor: a self-tuning
 * flow that adjusts its own cadence can slow down or speed up, but can't set
 * itself to an every-second pulse. The clamp REJECTS (never silently rewrites)
 * and lives on the MCP path only — the REST/builder UI path is deliberately
 * left unclamped so a human can still configure a fast poll. Named constant so
 * it is trivially tunable.
 */
const MIN_FLOW_SCHEDULE_INTERVAL_MS = 60_000;

/**
 * The slice of MCPService the dispatcher needs. Passed in by the caller instead
 * of importing the singleton, so this module never re-enters index.ts and tests
 * can hand in a plain mock.
 */
export interface InternalDispatchService {
  loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse>;
  getServerStatus(serverName: string): Promise<{ status: string; message?: string }>;
  listServerTools(
    serverName: string,
    audience?: ToolListAudience,
  ): Promise<{ tools: MCPToolResponse[]; error?: string }>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
    onProgress?: (progress: ToolCallProgress) => void,
    callerNodeId?: string,
    signal?: AbortSignal,
    source?: ToolCallSource,
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
      name: 'create_ticket_for_human',
      description: 'Create a dashboard ticket for the human operator. Use a concise plain-text message and optional comma-separated labels. Pass conversation_id or flow_id when known so the human can navigate back to the related work.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', description: 'Plain-text message for the human, maximum 4000 characters.' },
          labels: { type: 'string', description: 'Optional comma-separated label pills, maximum 12 labels.' },
          title: { type: 'string', description: 'Optional short headline, maximum 120 characters.' },
          conversation_id: { type: 'string', description: 'Optional related conversation id.' },
          message_id: { type: 'string', description: 'Optional related assistant message id.' },
          flow_id: { type: 'string', description: 'Optional related flow id.' },
        },
        required: ['message'],
      },
    },
    {
      name: 'propose_ui_action',
      description:
        'Propose a highlight or value change in the currently open FLUJO browser UI. ' +
        'Use this only when the prompt includes a current-page-context with an exact matching ' +
        'highlightTarget or editableTarget. This tool records a proposal; the browser validates ' +
        'the target and value again, highlights immediately, and requires the user to press Apply ' +
        'before any value change. Never invent a target that was not advertised in page context.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['highlight', 'set_value'] },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', minLength: 1, maxLength: 64 },
              id: { type: 'string', minLength: 1, maxLength: 256 },
              field: { type: 'string', minLength: 1, maxLength: 128 },
              path: { type: 'string', minLength: 1, maxLength: 512 },
            },
            required: ['kind'],
          },
          value: {},
          label: { type: 'string', maxLength: 160 },
          evidence: { type: 'string', maxLength: 2000 },
        },
        required: ['type', 'target'],
      },
    },
    {
      name: 'list_flows',
      description:
        'List all flows in this FLUJO instance with lightweight metadata only ' +
        '(id, name, description, node count) and no flow content. Use this to ' +
        'enumerate flows cheaply. Use list_flow_building_blocks only when you ' +
        'need the full authoring catalog (models + servers + flows).',
      inputSchema: listInputSchema({
        folder: { type: 'string', description: 'Exact folder name; use an empty string for ungrouped flows.' },
        favorite: { type: 'boolean', description: 'Filter by favorite state.' },
        updatedAfter: { type: 'number', description: 'Keep flows updated at or after this epoch-millisecond timestamp.' },
        updatedBefore: { type: 'number', description: 'Keep flows updated at or before this epoch-millisecond timestamp.' },
      }, { sorts: FLOW_SORTS }),
      outputSchema: listOutputSchema(),
    },
    {
      name: 'discover_capabilities',
      description:
        'Search FLUJO flows and tools exposed by configured MCP servers in one call. Returns exact invocation recipes and downstream input schemas, so you do not need to guess names or arguments. Use this before execute_flow or call_mcp_tool when you know the goal but not the capability.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 256, description: 'What you want to accomplish; matched against safe flow/tool names and descriptions.' },
          kinds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['flow', 'mcp_tool'] }, description: 'Optional capability kinds to search (default: both).' },
          server: { type: 'string', description: 'Optional exact MCP server name. Omit to search every enabled configured server.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum combined results (default 20, maximum 50).' },
        },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['flow', 'mcp_tool'] },
                id: { type: 'string' },
                server: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
                invocation: { type: 'object' },
                explanation: { type: 'object' },
              },
              required: ['kind', 'name', 'invocation'],
            },
          },
          total: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'total', 'hasMore'],
      },
    },
    {
      name: 'execute_flow',
      description:
        'Run another FLUJO flow (by name or id) with the given input and return its final output. The run is ephemeral (no chat conversation is created). Use list_flows or discover_capabilities to find a flow. Nested runs are limited in depth — a flow cannot recurse through itself indefinitely.',
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
      name: 'explain_flow',
      description:
        'Explain one compiled FLUJO flow in natural language: its ordered steps, control connections and conditions, model/MCP capabilities, Subflow child-job queues, signal emissions, and how planned executions connect it to trigger Waves. Read-only and deterministic.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flow: { type: 'string', description: 'Flow name or flow id (see list_flows or discover_capabilities).' },
        },
        required: ['flow'],
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
      inputSchema: listInputSchema({
          flow: { type: 'string', description: 'Flow name or flow id.' },
          savedAfter: { type: 'number', description: 'Keep versions saved at or after this epoch-millisecond timestamp.' },
          savedBefore: { type: 'number', description: 'Keep versions saved at or before this epoch-millisecond timestamp.' },
      }, { required: ['flow'], sorts: FLOW_VERSION_SORTS }),
      outputSchema: listOutputSchema(),
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
      inputSchema: listInputSchema({
        enabled: { type: 'boolean', description: 'Filter by enabled state.' },
        statuses: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: MCP_SERVER_STATUSES } },
        transports: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: MCP_TRANSPORTS } },
        folder: { type: 'string', description: 'Exact folder name; use an empty string for ungrouped servers.' },
        favorite: { type: 'boolean', description: 'Filter by favorite state.' },
      }, { sorts: SERVER_SORTS }),
      outputSchema: listOutputSchema(),
    },
    {
      name: 'list_mcp_server_tools',
      description:
        'List the tools of one configured MCP server (name, description, input schema). Use together with call_mcp_tool for servers that are not bound to this flow.',
      inputSchema: listInputSchema({
          server: { type: 'string', description: 'The FLUJO server name (see list_mcp_servers).' },
          includeSchema: { type: 'boolean', description: 'Include each tool input schema (default true).' },
      }, { required: ['server'], sorts: TOOL_SORTS }),
      outputSchema: listOutputSchema(),
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
    ...(systemScreenshotToolDefinition() ? [systemScreenshotToolDefinition()!] : []),
    {
      name: 'list_models',
      description:
        'List the models configured in this FLUJO instance (id, name, display name, description, provider, base URL, context window). API keys are never included. Reference models by id or name in FlowSpecs.',
      inputSchema: listInputSchema({
        providers: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
        adapters: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
        supportsTools: { type: 'boolean', description: 'Filter models with an explicit tool-capability value.' },
        visionInput: { type: 'string', enum: ['supported', 'unsupported', 'unknown'] },
        folder: { type: 'string', description: 'Exact folder name; use an empty string for ungrouped models.' },
        favorite: { type: 'boolean', description: 'Filter by favorite state.' },
        minContextWindow: { type: 'number', minimum: 0 },
      }, { sorts: MODEL_SORTS }),
      outputSchema: listOutputSchema(),
    },
    {
      name: 'list_planned_executions',
      description:
        'List the planned (scheduled/triggered) executions in this FLUJO instance with their trigger type, enabled state, armed status and last run outcome.',
      inputSchema: listInputSchema({
        states: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: PLANNED_EXECUTION_STATES } },
        triggerTypes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: TRIGGER_TYPES } },
        lastRunStatuses: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: RUN_STATUSES } },
        flow: { type: 'string', description: 'Exact flow name or id.' },
        folder: { type: 'string', description: 'Exact folder name; use an empty string for ungrouped executions.' },
        armed: { type: 'boolean' },
      }, { sorts: PLANNED_EXECUTION_SORTS }),
      outputSchema: listOutputSchema(),
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
      name: 'update_planned_execution',
      description:
        'Modify an existing planned execution (by id or name, see list_planned_executions). Patch any of: "enabled" (turn the schedule on/off), "prompt" (the run prompt), "flowId" (the flow to run — accepts a flow name or id), "cron" (a convenience for the trigger\'s cron pattern — works for schedule / mcp-poll / url-watch triggers) or a full "trigger" object for complete control. Flow-driven cadence changes are clamped to a minimum interval (a runaway every-second schedule is rejected). The webhook secret token is never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          execution: { type: 'string', description: 'The planned execution id or name.' },
          enabled: { type: 'boolean', description: 'Enable or disable the execution.' },
          prompt: { type: 'string', description: 'The run prompt.' },
          flowId: { type: 'string', description: 'The flow to run — a flow name or id (resolved to the flow id).' },
          cron: { type: 'string', description: 'Cron pattern (croner syntax; 6-field form for seconds) for the trigger\'s schedule. Applies to schedule / mcp-poll / url-watch triggers.' },
          trigger: { type: 'object', description: 'Full trigger config object (escape hatch for complete control). Prefer the named fields above.' },
        },
        required: ['execution'],
      },
    },
    {
      name: 'create_planned_execution',
      description:
        'Create a new planned execution: bind a flow to a trigger so it runs headlessly. Provide "name", "flow" (a flow name or id), an optional "prompt", optional "enabled" (default true), and EITHER a full "trigger" object OR a convenience "cron" (which creates a schedule trigger). Flow-driven cadence is clamped to a minimum interval. A webhook trigger\'s secret token is minted server-side and never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A name for the planned execution.' },
          flow: { type: 'string', description: 'The flow to run — a flow name or id.' },
          prompt: { type: 'string', description: 'The run prompt (may be empty).' },
          enabled: { type: 'boolean', description: 'Whether to arm the trigger immediately (default true).' },
          cron: { type: 'string', description: 'Cron pattern for a schedule trigger (convenience — use "trigger" for other trigger types).' },
          trigger: { type: 'object', description: 'Full trigger config object (schedule / webhook / file-watch / mcp-poll / url-watch).' },
        },
        required: ['name', 'flow'],
      },
    },
    {
      name: 'delete_planned_execution',
      description:
        'Permanently delete a planned execution (by id or name, see list_planned_executions), along with its run history. This cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          execution: { type: 'string', description: 'The planned execution id or name.' },
        },
        required: ['execution'],
      },
    },
    {
      name: 'list_conversations',
      description:
        'List lightweight chat-conversation summaries with status, flow, activity, planned-execution and hierarchy filters. Defaults to the 50 most recently active conversations. Use read_conversation to get a transcript.',
      inputSchema: listInputSchema({
        statuses: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: CONVERSATION_STATUSES } },
        flow: { type: 'string', description: 'Exact flow name or id.' },
        plannedExecutionId: { type: 'string' },
        parentConversationId: { type: 'string' },
        rootConversationId: { type: 'string' },
        updatedAfter: { type: 'number', description: 'Keep conversations active at or after this epoch-millisecond timestamp.' },
        updatedBefore: { type: 'number', description: 'Keep conversations active at or before this epoch-millisecond timestamp.' },
      }, { sorts: CONVERSATION_SORTS }),
      outputSchema: listOutputSchema(),
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
      name: 'kv_get',
      description:
        'Read a value from FLUJO\'s PERSISTENT key-value store (the ${kv:NAME} store) — state that survives ACROSS flow runs (loop counters, cursors, flags). Returns { found, value }. Defaults to the instance-global board; pass "scope" to target another board (e.g. a flow-folder board id). Values are plain strings, never secrets.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The key to read (an identifier: letters, digits, _ and -, not starting with a digit).' },
          scope: { type: 'string', description: 'Optional board id to read from. Defaults to "global".' },
        },
        required: ['name'],
      },
    },
    {
      name: 'kv_set',
      description:
        'Write a value to FLUJO\'s PERSISTENT key-value store (the ${kv:NAME} store) — state that survives ACROSS flow runs. Last-write-wins. Defaults to the instance-global board; pass "scope" to target another board. Values are plain strings (never secrets — use ${global:} for those) and are size-capped; an oversized write is refused with { saved:false, skipped }.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The key to write (an identifier: letters, digits, _ and -, not starting with a digit).' },
          value: { type: 'string', description: 'The string value to store.' },
          scope: { type: 'string', description: 'Optional board id to write to. Defaults to "global".' },
        },
        required: ['name', 'value'],
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

  const store = internalFlowDepthStore();
  const inheritedDepth = store.getStore();
  // The numeric global remains a compatibility-only test override. Runtime
  // recursion lives in AsyncLocalStorage, so concurrent calls cannot consume
  // one another's budget (within or across workspaces).
  const depth = inheritedDepth ?? global.__flujo_internal_flow_depth ?? 0;
  if (depth >= MAX_EXECUTE_FLOW_DEPTH) {
    return textResult(
      { error: `execute_flow nesting limit (${MAX_EXECUTE_FLOW_DEPTH}) reached — refusing to start "${flow.name}" to prevent runaway recursion.` },
      true
    );
  }

  return store.run(depth + 1, async () => {
    try {
    const result = await runFlow({
      flowId: flow.id,
      prompt: String(args?.input ?? ''),
      source: 'internal',
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
      // Preserve the old observable reset used by the test suite without using
      // this mutable value to track live runtime depth.
      if (inheritedDepth === undefined) global.__flujo_internal_flow_depth = 0;
    }
  });
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
      type: data?.edgeType === 'mcp' ? 'mcp' : data?.edgeType === 'resource' ? 'resource' : 'control',
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
  const parsed = parseListArgs(args, {
    allowed: ['flow', 'savedAfter', 'savedBefore'],
    sorts: FLOW_VERSION_SORTS,
    defaultSort: 'saved-desc',
    defaultLimit: 25,
  });
  const ref = optionalString(args, 'flow') ?? '';
  if (!ref) {
    return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  }
  const flow = await resolveFlow(ref);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${ref}".` }, true);
  }
  const savedAfter = optionalFiniteNumber(args, 'savedAfter');
  const savedBefore = optionalFiniteNumber(args, 'savedBefore');
  let versions = await flowService.listFlowVersions(flow.id);
  versions = versions.filter((version) =>
    (!parsed.query || `${version.versionId} ${version.name}`.toLocaleLowerCase().includes(parsed.query)) &&
    (savedAfter === undefined || version.savedAt >= savedAfter) &&
    (savedBefore === undefined || version.savedAt <= savedBefore));
  versions.sort((a, b) =>
    parsed.sort === 'saved-asc'
      ? a.savedAt - b.savedAt || a.versionId.localeCompare(b.versionId)
      : b.savedAt - a.savedAt || a.versionId.localeCompare(b.versionId));
  const page = paginateList(versions, parsed);
  const payload = {
    flowId: flow.id,
    flowName: flow.name,
    versions: page.items,
    ...(page.items.length === 0
      ? { note: 'No archived versions yet — versions appear once the flow\'s definition is overwritten for the first time.' }
      : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: page as unknown as Record<string, unknown>,
  };
}

async function explainFlow(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.flow ?? '').trim();
  if (!ref) return textResult({ error: 'Provide "flow": a flow name or id.' }, true);
  const flows = await flowService.loadFlows();
  const flow = flows.find((candidate) => candidate.id === ref) ?? flows.find((candidate) => candidate.name === ref);
  if (!flow) return textResult({ error: `No flow named or with id "${ref}". Use list_flows or discover_capabilities.` }, true);
  const executions = await getSchedulerService().list().catch((error) => {
    log.warn('explain_flow could not load planned executions; omitting Waves context', error);
    return [];
  });
  return textResult(explainCompiledFlow(flow, flows, executions));
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

async function listMcpServers(
  service: InternalDispatchService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = parseListArgs(args, {
    allowed: ['enabled', 'statuses', 'transports', 'folder', 'favorite'],
    sorts: SERVER_SORTS,
    defaultSort: 'name-asc',
  });
  const enabled = optionalBoolean(args, 'enabled');
  const statuses = optionalStringArray(args, 'statuses', MCP_SERVER_STATUSES);
  const transports = optionalStringArray(args, 'transports', MCP_TRANSPORTS);
  const folder = optionalString(args, 'folder', { allowEmpty: true });
  const favorite = optionalBoolean(args, 'favorite');
  const configs = await service.loadServerConfigs();
  if (!Array.isArray(configs)) {
    return textResult({ error: configs.error ?? 'Failed to load server configs.' }, true);
  }
  const candidates = configs.filter((config) =>
    (enabled === undefined || !config.disabled === enabled) &&
    (!transports || transports.includes(config.transport)) &&
    (folder === undefined || (config.folder ?? '') === folder) &&
    (favorite === undefined || Boolean(config.favorite) === favorite));
  let servers = await Promise.all(
    candidates.map(async (config) => {
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
        ...(config.folder ? { folder: config.folder } : {}),
        ...(config.favorite ? { favorite: true } : {}),
      };
    })
  );
  servers = servers.filter((server) =>
    (!statuses || statuses.includes(server.status)) &&
    (!parsed.query || `${server.name} ${server.transport} ${server.status} ${server.folder ?? ''}`.toLocaleLowerCase().includes(parsed.query)));
  servers.sort((a, b) => {
    switch (parsed.sort) {
      case 'name-desc': return b.name.localeCompare(a.name);
      case 'status': return a.status.localeCompare(b.status) || a.name.localeCompare(b.name);
      case 'transport': return a.transport.localeCompare(b.transport) || a.name.localeCompare(b.name);
      default: return a.name.localeCompare(b.name);
    }
  });
  return pagedCallToolResult(paginateList(servers, parsed));
}

async function listMcpServerTools(
  service: InternalDispatchService,
  args: Record<string, unknown>,
  source: ToolCallSource,
): Promise<CallToolResult> {
  const parsed = parseListArgs(args, {
    allowed: ['server', 'includeSchema'],
    sorts: TOOL_SORTS,
    defaultSort: 'name-asc',
  });
  const server = optionalString(args, 'server') ?? '';
  const includeSchema = optionalBoolean(args, 'includeSchema') ?? true;
  if (!server) {
    return textResult({ error: 'Provide "server": a FLUJO server name.' }, true);
  }
  const audience: ToolListAudience = source === 'host' ? 'all' : source;
  const { tools, error } = await service.listServerTools(server, audience);
  if (error) {
    return textResult({ error }, true);
  }
  const summaries = tools
    .filter((tool) => !parsed.query || `${tool.name} ${tool.description ?? ''}`.toLocaleLowerCase().includes(parsed.query))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(includeSchema ? { inputSchema: tool.inputSchema } : {}),
    }))
    .sort((a, b) => parsed.sort === 'name-desc'
      ? b.name.localeCompare(a.name)
      : a.name.localeCompare(b.name));
  return pagedCallToolResult(paginateList(summaries, parsed));
}

async function discoverCapabilities(
  service: InternalDispatchService,
  args: Record<string, unknown>,
  source: ToolCallSource,
): Promise<CallToolResult> {
  const query = String(args?.query ?? '').trim();
  if (!query) return textResult({ error: 'Provide a non-empty "query" describing the capability you need.' }, true);
  if (query.length > 256) return textResult({ error: '"query" must be at most 256 characters.' }, true);
  const rawKinds = args?.kinds;
  const kinds = Array.isArray(rawKinds) ? rawKinds.map(String) : ['flow', 'mcp_tool'];
  if (kinds.length === 0 || kinds.some((kind) => !['flow', 'mcp_tool'].includes(kind))) {
    return textResult({ error: '"kinds" may contain only "flow" and "mcp_tool".' }, true);
  }
  const serverFilter = typeof args?.server === 'string' ? args.server.trim() : '';
  const limit = typeof args?.limit === 'number' && Number.isInteger(args.limit)
    ? Math.min(50, Math.max(1, args.limit))
    : 20;
  const needle = query.toLocaleLowerCase();
  const stopWords = new Set(['and', 'for', 'from', 'into', 'need', 'that', 'the', 'this', 'tool', 'want', 'with']);
  const tokens = [...new Set(needle.split(/[^a-z0-9_-]+/).filter((token) => token.length > 2 && !stopWords.has(token)))];
  const score = (name: string, haystack: string): number => {
    const normalizedName = name.toLocaleLowerCase();
    const normalized = haystack.toLocaleLowerCase();
    if (normalizedName === needle) return 1000;
    if (normalizedName.includes(needle)) return 800;
    if (normalized.includes(needle)) return 600;
    const matched = tokens.filter((token) => normalized.includes(token));
    if (matched.length === 0) return -1;
    return matched.length * 100 + matched.filter((token) => normalizedName.includes(token)).length * 25;
  };
  const results: Array<{ score: number; item: Record<string, unknown> }> = [];

  if (kinds.includes('flow')) {
    const flows = await flowService.loadFlows();
    for (const flow of flows) {
      const relevance = score(flow.name, `${flow.name} ${flow.description ?? ''} ${flow.folder ?? ''}`);
      if (relevance < 0) continue;
      results.push({ score: relevance, item: {
        kind: 'flow',
        id: flow.id,
        name: flow.name,
        ...(flow.description ? { description: truncate(flow.description, MAX_FLOW_DESCRIPTION_CHARS) } : {}),
        invocation: { tool: 'execute_flow', arguments: { flow: flow.id, input: '<user request>' } },
        explanation: { tool: 'explain_flow', arguments: { flow: flow.id } },
      } });
    }
  }

  if (kinds.includes('mcp_tool')) {
    const configs = await service.loadServerConfigs();
    if (!Array.isArray(configs)) return textResult({ error: configs.error ?? 'Failed to load server configs.' }, true);
    const candidates = configs.filter((config) => !config.disabled && (!serverFilter || config.name === serverFilter));
    if (serverFilter && candidates.length === 0) {
      return textResult({ error: `No enabled MCP server named "${serverFilter}".` }, true);
    }
    const audience: ToolListAudience = source === 'host' ? 'all' : source;
    const discoveries = await Promise.all(candidates.map(async (config) => ({
      config,
      listed: await service.listServerTools(config.name, audience),
    })));
    for (const { config, listed } of discoveries) {
      if (listed.error) continue;
      for (const tool of listed.tools) {
        const relevance = score(tool.name, `${config.name} ${tool.name} ${tool.description ?? ''}`);
        if (relevance < 0) continue;
        results.push({ score: relevance, item: {
          kind: 'mcp_tool',
          server: config.name,
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          invocation: { tool: 'call_mcp_tool', arguments: { server: config.name, tool: tool.name, args: {} } },
        } });
      }
    }
  }

  results.sort((a, b) => {
    const aName = `${a.item.name ?? ''}`.toLocaleLowerCase();
    const bName = `${b.item.name ?? ''}`.toLocaleLowerCase();
    return b.score - a.score || aName.localeCompare(bName) || `${a.item.server ?? ''}`.localeCompare(`${b.item.server ?? ''}`);
  });
  const items = results.slice(0, limit).map((result) => result.item);
  return {
    content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    structuredContent: { items, total: results.length, hasMore: results.length > items.length },
  };
}

async function callMcpTool(
  service: InternalDispatchService,
  args: Record<string, unknown>,
  source: ToolCallSource,
): Promise<CallToolResult> {
  const server = String(args?.server ?? '').trim();
  const tool = String(args?.tool ?? '').trim();
  if (!server || !tool) {
    return textResult({ error: 'Provide "server" and "tool".' }, true);
  }
  const toolArgs =
    args?.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {};
  const timeout = typeof args?.timeout === 'number' ? args.timeout : undefined;

  const result = await service.callTool(
    server,
    tool,
    toolArgs,
    timeout,
    undefined,
    undefined,
    undefined,
    source,
  );
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
  const result = await service.updateServerConfig(server, { disabled: !enabled });
  if ('error' in result) {
    return textResult({ error: result.error }, true);
  }
  return textResult({ server, enabled });
}

async function listFlows(args: Record<string, unknown>): Promise<CallToolResult> {
  // Lightweight enumeration: reuses flowService.loadFlows() and returns the same
  // reduced per-flow metadata shape as list_flow_building_blocks' `flows` array
  // (id, name, truncated description, nodeCount) — never node/edge content or
  // any secrets. Cheap alternative to the full authoring catalog.
  try {
    const parsed = parseListArgs(args, {
      allowed: ['folder', 'favorite', 'updatedAfter', 'updatedBefore'],
      sorts: FLOW_SORTS,
      defaultSort: 'name-asc',
    });
    const folder = optionalString(args, 'folder', { allowEmpty: true });
    const favorite = optionalBoolean(args, 'favorite');
    const updatedAfter = optionalFiniteNumber(args, 'updatedAfter');
    const updatedBefore = optionalFiniteNumber(args, 'updatedBefore');
    const flows = await flowService.loadFlows();
    const flowList = flows.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.description ? { description: truncate(f.description, MAX_FLOW_DESCRIPTION_CHARS) } : {}),
      nodeCount: f.nodes?.length ?? 0,
      ...(f.folder ? { folder: f.folder } : {}),
      ...(f.favorite ? { favorite: true } : {}),
      ...(f.createdAt !== undefined ? { createdAt: f.createdAt } : {}),
      ...(f.updatedAt !== undefined ? { updatedAt: f.updatedAt } : {}),
    })).filter((flow) => {
      const timestamp = flow.updatedAt ?? flow.createdAt ?? 0;
      return (!parsed.query || `${flow.id} ${flow.name} ${flow.description ?? ''} ${flow.folder ?? ''}`.toLocaleLowerCase().includes(parsed.query)) &&
        (folder === undefined || (flow.folder ?? '') === folder) &&
        (favorite === undefined || Boolean(flow.favorite) === favorite) &&
        (updatedAfter === undefined || timestamp >= updatedAfter) &&
        (updatedBefore === undefined || timestamp <= updatedBefore);
    });
    flowList.sort((a, b) => {
      const aTime = a.updatedAt ?? a.createdAt ?? 0;
      const bTime = b.updatedAt ?? b.createdAt ?? 0;
      switch (parsed.sort) {
        case 'name-desc': return b.name.localeCompare(a.name) || b.id.localeCompare(a.id);
        case 'updated-desc': return bTime - aTime || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        case 'updated-asc': return aTime - bTime || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        case 'nodes-desc': return b.nodeCount - a.nodeCount || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        case 'nodes-asc': return a.nodeCount - b.nodeCount || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        default: return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      }
    });
    return pagedCallToolResult(paginateList(flowList, parsed));
  } catch (error) {
    if (error instanceof ListArgumentError) throw error;
    log.error('list_flows failed', error);
    return textResult({ error: 'Failed to load flows.' }, true);
  }
}

async function listModels(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = parseListArgs(args, {
    allowed: ['providers', 'adapters', 'supportsTools', 'visionInput', 'folder', 'favorite', 'minContextWindow'],
    sorts: MODEL_SORTS,
    defaultSort: 'name-asc',
  });
  const providers = optionalStringArray(args, 'providers');
  const adapters = optionalStringArray(args, 'adapters');
  const supportsTools = optionalBoolean(args, 'supportsTools');
  const visionInput = optionalString(args, 'visionInput');
  if (visionInput && !['supported', 'unsupported', 'unknown'].includes(visionInput)) {
    throw new ListArgumentError('"visionInput" must be supported, unsupported, or unknown.');
  }
  const folder = optionalString(args, 'folder', { allowEmpty: true });
  const favorite = optionalBoolean(args, 'favorite');
  const minContextWindow = optionalFiniteNumber(args, 'minContextWindow');
  if (minContextWindow !== undefined && minContextWindow < 0) {
    throw new ListArgumentError('"minContextWindow" must be zero or greater.');
  }
  const models = await modelService.loadModels();
  // Strict whitelist: model configs carry the (encrypted) ApiKey, which must never
  // reach a model's context. Only inert metadata goes out.
  const safeModels = models.filter((model) =>
    (!parsed.query || `${model.id} ${model.name} ${model.displayName ?? ''} ${model.description ?? ''} ${model.provider ?? ''} ${model.adapter ?? ''} ${model.folder ?? ''}`.toLocaleLowerCase().includes(parsed.query)) &&
    (!providers || providers.includes(model.provider ?? 'openai')) &&
    (!adapters || adapters.includes(model.adapter ?? 'openai')) &&
    (supportsTools === undefined || model.supportsTools === supportsTools) &&
    (visionInput === undefined || model.visionInputCapability === visionInput) &&
    (folder === undefined || (model.folder ?? '') === folder) &&
    (favorite === undefined || Boolean(model.favorite) === favorite) &&
    (minContextWindow === undefined || (model.contextWindow ?? 0) >= minContextWindow))
    .map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.adapter ? { adapter: m.adapter } : {}),
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
      ...(m.visionInputCapability ? { visionInputCapability: m.visionInputCapability } : {}),
      ...(m.folder ? { folder: m.folder } : {}),
      ...(m.favorite ? { favorite: true } : {}),
    }));
  safeModels.sort((a, b) => {
    const aName = a.displayName ?? a.name;
    const bName = b.displayName ?? b.name;
    switch (parsed.sort) {
      case 'name-desc': return bName.localeCompare(aName) || b.id.localeCompare(a.id);
      case 'provider': return (a.provider ?? '').localeCompare(b.provider ?? '') || aName.localeCompare(bName);
      case 'context-desc': return (b.contextWindow ?? -1) - (a.contextWindow ?? -1) || aName.localeCompare(bName);
      case 'context-asc': {
        if (a.contextWindow === undefined) return b.contextWindow === undefined ? aName.localeCompare(bName) : 1;
        if (b.contextWindow === undefined) return -1;
        return a.contextWindow - b.contextWindow || aName.localeCompare(bName);
      }
      default: return aName.localeCompare(bName) || a.id.localeCompare(b.id);
    }
  });
  return pagedCallToolResult(paginateList(safeModels, parsed));
}

async function listPlannedExecutions(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = parseListArgs(args, {
    allowed: ['states', 'triggerTypes', 'lastRunStatuses', 'flow', 'folder', 'armed'],
    sorts: PLANNED_EXECUTION_SORTS,
    defaultSort: 'name-asc',
  });
  const states = optionalStringArray(args, 'states', PLANNED_EXECUTION_STATES);
  const triggerTypes = optionalStringArray(args, 'triggerTypes', TRIGGER_TYPES);
  const lastRunStatuses = optionalStringArray(args, 'lastRunStatuses', RUN_STATUSES);
  const flowRef = optionalString(args, 'flow');
  const folder = optionalString(args, 'folder', { allowEmpty: true });
  const armed = optionalBoolean(args, 'armed');
  const resolvedFlow = flowRef ? await resolveFlow(flowRef) : undefined;
  const flowId = resolvedFlow?.id ?? flowRef;
  let entries = await getSchedulerService().list();
  entries = entries.filter((entry) =>
    (!parsed.query || matchesPlannedExecutionSearch(entry, parsed.query)) &&
    (!states || states.some((state) => matchesPlannedExecutionStatus(entry, state as PlannedExecutionFilter))) &&
    (!triggerTypes || triggerTypes.includes(entry.execution.trigger.type)) &&
    (!lastRunStatuses || (entry.lastRun && lastRunStatuses.includes(entry.lastRun.status))) &&
    (flowId === undefined || entry.execution.flowId === flowId) &&
    (folder === undefined || (entry.execution.folder ?? '') === folder) &&
    (armed === undefined || Boolean(entry.status?.armed) === armed));
  entries = sortPlannedExecutions(entries, parsed.sort as PlannedExecutionSortOption);
  // Trigger configs are reduced to their TYPE: webhook triggers carry a secret
  // token, and none of the other trigger details are needed to pick a run target.
  const safeEntries = entries.map(({ execution, status, lastRun }) => ({
      id: execution.id,
      name: execution.name,
      enabled: execution.enabled,
      flowId: execution.flowId,
      triggerType: execution.trigger?.type,
      armed: status?.armed ?? false,
      running: status?.running ?? false,
      ...(status?.lastTriggerError ? { lastTriggerError: status.lastTriggerError } : {}),
      ...(execution.folder ? { folder: execution.folder } : {}),
      ...(execution.createdAt ? { createdAt: execution.createdAt } : {}),
      ...(execution.updatedAt ? { updatedAt: execution.updatedAt } : {}),
      ...(lastRun
        ? {
            lastRun: {
              status: lastRun.status,
              firedAt: lastRun.firedAt,
              ...(lastRun.error ? { error: lastRun.error } : {}),
            },
          }
        : {}),
    }));
  return pagedCallToolResult(paginateList(safeEntries, parsed));
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

/** Resolve a planned execution by id first (exact), then by name. */
async function resolvePlannedExecution(ref: string): Promise<PlannedExecution | null> {
  const entries = await getSchedulerService().list();
  const byId = entries.find((e) => e.execution.id === ref);
  const byName = entries.find((e) => e.execution.name === ref);
  return (byId ?? byName)?.execution ?? null;
}

/**
 * The whitelist a planned execution is reduced to on the way out of a write:
 * exactly the fields list_planned_executions surfaces, so a webhook trigger's
 * secret token (or any other trigger detail) can never ride back into the
 * calling model's context.
 */
function redactExecution(execution: PlannedExecution): Record<string, unknown> {
  return {
    id: execution.id,
    name: execution.name,
    enabled: execution.enabled,
    flowId: execution.flowId,
    triggerType: execution.trigger?.type,
  };
}

/** Cron-bearing trigger types whose cadence a bare "cron" convenience field can set. */
function triggerHasCron(
  trigger: TriggerConfig
): trigger is Extract<TriggerConfig, { type: 'schedule' | 'mcp-poll' | 'url-watch' }> {
  return trigger.type === 'schedule' || trigger.type === 'mcp-poll' || trigger.type === 'url-watch';
}

/**
 * Shortest gap (ms) between two consecutive fires of a cron pattern, computed
 * with the same croner the scheduler arms with. Returns null when the pattern
 * can't be projected (invalid pattern — validation happens in the service).
 */
function cronMinGapMs(cron: string, timezone?: string): number | null {
  try {
    const runs = scheduleNextRuns(cron, timezone, 5).map((iso) => new Date(iso).getTime());
    let min = Infinity;
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i] - runs[i - 1];
      if (gap > 0 && gap < min) min = gap;
    }
    return Number.isFinite(min) ? min : null;
  } catch {
    return null;
  }
}

/**
 * Runaway-cadence guardrail. Returns an error string when the trigger would fire
 * faster than MIN_FLOW_SCHEDULE_INTERVAL_MS, else null. Cron-less trigger types
 * (webhook, file-watch) are never clamped.
 */
function assertCadenceAllowed(trigger: TriggerConfig): string | null {
  let intervalMs: number | null = null;
  if (trigger.type === 'schedule' || trigger.type === 'url-watch') {
    if (trigger.cron) intervalMs = cronMinGapMs(trigger.cron, trigger.timezone);
  } else if (trigger.type === 'mcp-poll') {
    if (trigger.cron) intervalMs = cronMinGapMs(trigger.cron, trigger.timezone);
    else if (typeof trigger.intervalMs === 'number') intervalMs = trigger.intervalMs;
  }
  if (intervalMs !== null && intervalMs < MIN_FLOW_SCHEDULE_INTERVAL_MS) {
    return `Cadence too fast: the trigger would fire about every ${Math.round(
      intervalMs / 1000
    )}s, but flow-driven schedule changes are clamped to a minimum interval of ${
      MIN_FLOW_SCHEDULE_INTERVAL_MS / 1000
    }s. Choose a slower cadence (change it from the Planned Executions page for a faster one).`;
  }
  return null;
}

async function updatePlannedExecution(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.execution ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "execution": a planned execution id or name (see list_planned_executions).' }, true);
  }
  const target = await resolvePlannedExecution(ref);
  if (!target) {
    return textResult({ error: `No planned execution with id or name "${ref}". Use list_planned_executions to see them.` }, true);
  }

  const patch: Partial<Omit<PlannedExecution, 'id' | 'createdAt' | 'updatedAt'>> = {};
  if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled;
  if (typeof args?.prompt === 'string') patch.prompt = args.prompt;

  const flowRef = String(args?.flowId ?? args?.flow ?? '').trim();
  if (flowRef) {
    const flow = await resolveFlow(flowRef);
    if (!flow) {
      return textResult({ error: `No flow named or with id "${flowRef}". Use list_flow_building_blocks to see the flows.` }, true);
    }
    patch.flowId = flow.id;
  }

  // Trigger changes: a full trigger object (escape hatch) and/or a bare cron
  // convenience layered on top of the effective trigger.
  let nextTrigger: TriggerConfig | undefined;
  if (args?.trigger && typeof args.trigger === 'object' && !Array.isArray(args.trigger)) {
    nextTrigger = args.trigger as TriggerConfig;
  }
  const cron = typeof args?.cron === 'string' ? args.cron.trim() : '';
  if (cron) {
    const base = nextTrigger ?? target.trigger;
    if (!triggerHasCron(base)) {
      return textResult(
        { error: `The "${base.type}" trigger has no schedule to change with "cron". Pass a full "trigger" object instead.` },
        true
      );
    }
    nextTrigger = { ...base, cron };
  }
  if (nextTrigger) {
    const cadenceError = assertCadenceAllowed(nextTrigger);
    if (cadenceError) {
      return textResult({ error: cadenceError }, true);
    }
    patch.trigger = nextTrigger;
  }

  if (Object.keys(patch).length === 0) {
    return textResult({ error: 'Nothing to update. Provide at least one of: enabled, prompt, flowId, cron, trigger.' }, true);
  }

  const result = await getSchedulerService().update(target.id, patch);
  if (result.error || !result.execution) {
    return textResult({ error: result.error ?? 'Update failed.' }, true);
  }
  return textResult({ updated: true, ...redactExecution(result.execution) });
}

async function createPlannedExecution(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = String(args?.name ?? '').trim();
  if (!name) {
    return textResult({ error: 'Provide "name": a name for the planned execution.' }, true);
  }
  const flowRef = String(args?.flow ?? args?.flowId ?? '').trim();
  if (!flowRef) {
    return textResult({ error: 'Provide "flow": a flow name or id to run.' }, true);
  }
  const flow = await resolveFlow(flowRef);
  if (!flow) {
    return textResult({ error: `No flow named or with id "${flowRef}". Use list_flow_building_blocks to see the flows.` }, true);
  }

  let trigger: TriggerConfig;
  if (args?.trigger && typeof args.trigger === 'object' && !Array.isArray(args.trigger)) {
    trigger = args.trigger as TriggerConfig;
  } else {
    const cron = typeof args?.cron === 'string' ? args.cron.trim() : '';
    if (!cron) {
      return textResult({ error: 'Provide a "trigger" object or a "cron" pattern (which creates a schedule trigger).' }, true);
    }
    trigger = { type: 'schedule', cron };
  }
  const cadenceError = assertCadenceAllowed(trigger);
  if (cadenceError) {
    return textResult({ error: cadenceError }, true);
  }

  const input = {
    name,
    enabled: typeof args?.enabled === 'boolean' ? args.enabled : true,
    flowId: flow.id,
    prompt: typeof args?.prompt === 'string' ? args.prompt : '',
    trigger,
  };
  const result = await getSchedulerService().create(input);
  if (result.error || !result.execution) {
    return textResult({ error: result.error ?? 'Create failed.' }, true);
  }
  return textResult({ created: true, ...redactExecution(result.execution) });
}

async function deletePlannedExecution(args: Record<string, unknown>): Promise<CallToolResult> {
  const ref = String(args?.execution ?? '').trim();
  if (!ref) {
    return textResult({ error: 'Provide "execution": a planned execution id or name (see list_planned_executions).' }, true);
  }
  const target = await resolvePlannedExecution(ref);
  if (!target) {
    return textResult({ error: `No planned execution with id or name "${ref}". Use list_planned_executions to see them.` }, true);
  }
  const result = await getSchedulerService().delete(target.id);
  if (!result.success) {
    return textResult({ error: result.error ?? `Failed to delete "${target.name}".` }, true);
  }
  return textResult({ deleted: true, id: target.id, name: target.name });
}

/**
 * List stored conversations as light summaries. Reads the derived summary index
 * and backfills missing or stale entries from snapshots, so repeated listings do
 * not deserialize every message while still returning current metadata.
 */
async function listConversations(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = parseListArgs(args, {
    allowed: [
      'statuses',
      'flow',
      'plannedExecutionId',
      'parentConversationId',
      'rootConversationId',
      'updatedAfter',
      'updatedBefore',
    ],
    sorts: CONVERSATION_SORTS,
    defaultSort: 'activity-desc',
  });
  const statuses = optionalStringArray(args, 'statuses', CONVERSATION_STATUSES);
  const flowRef = optionalString(args, 'flow');
  const plannedExecutionId = optionalString(args, 'plannedExecutionId');
  const parentConversationId = optionalString(args, 'parentConversationId');
  const rootConversationId = optionalString(args, 'rootConversationId');
  const updatedAfter = optionalFiniteNumber(args, 'updatedAfter');
  const updatedBefore = optionalFiniteNumber(args, 'updatedBefore');
  const resolvedFlow = flowRef ? await resolveFlow(flowRef) : undefined;
  const flowId = resolvedFlow?.id ?? flowRef;

  const stored = await listConversationSummaries();
  const summaries = stored.map((summary): ConversationSummary => {
    // Match the main conversations API: in-memory state wins while a run is in
    // flight, and a stored 'running' record with no event channel is interrupted.
    const live = FlowExecutor.conversationStates.get(summary.id);
    let status = live?.status ?? summary.status;
    if (status === 'running' && executionEventBus.currentSeq(summary.id) === 0) status = 'error';
    return {
      ...summary,
      title: live?.title ?? summary.title,
      flowId: live?.flowId ?? summary.flowId,
      ...(status ? { status } : {}),
      updatedAt: live?.updatedAt ?? summary.updatedAt,
      lastUserMessageAt: live?.lastUserMessageAt ?? summary.lastUserMessageAt ?? null,
      plannedExecutionId: live?.plannedExecutionId ?? summary.plannedExecutionId ?? null,
      parentConversationId: live?.parentConversationId ?? summary.parentConversationId ?? null,
      rootConversationId: live?.rootConversationId ?? summary.rootConversationId ?? null,
      recovery: live?.recovery ?? summary.recovery,
    };
  }).filter((summary) => {
    const status = summary.status ?? 'not_started';
    const activityAt = summary.lastUserMessageAt ?? summary.updatedAt;
    const haystack = `${summary.id} ${summary.title} ${summary.flowId ?? ''} ${summary.plannedExecutionId ?? ''}`.toLocaleLowerCase();
    return (!parsed.query || haystack.includes(parsed.query)) &&
      (!statuses || statuses.includes(status)) &&
      (flowId === undefined || summary.flowId === flowId) &&
      (plannedExecutionId === undefined || summary.plannedExecutionId === plannedExecutionId) &&
      (parentConversationId === undefined || summary.parentConversationId === parentConversationId) &&
      (rootConversationId === undefined || summary.rootConversationId === rootConversationId) &&
      (updatedAfter === undefined || activityAt >= updatedAfter) &&
      (updatedBefore === undefined || activityAt <= updatedBefore);
  });

  summaries.sort((a, b) => {
    const aActivity = a.lastUserMessageAt ?? a.updatedAt;
    const bActivity = b.lastUserMessageAt ?? b.updatedAt;
    switch (parsed.sort) {
      case 'activity-asc': return aActivity - bActivity || a.id.localeCompare(b.id);
      case 'created-desc': return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
      case 'created-asc': return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
      case 'title-asc': return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      case 'title-desc': return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
      default: return bActivity - aActivity || a.id.localeCompare(b.id);
    }
  });
  return pagedCallToolResult(paginateList(summaries, parsed));
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

/** Persistent key-value store (${kv:NAME}) tool bounds. Board id and key must be
 *  filesystem-safe / a sane identifier respectively (same gate as the store). */
const KV_SCOPE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KV_KEY_RE = /^[A-Za-z_][\w-]*$/;

async function kvGetTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : 'global';
  if (!KV_KEY_RE.test(name)) {
    return textResult({ error: 'kv_get requires a valid "name" (letters, digits, _ and -, not starting with a digit).' }, true);
  }
  if (!KV_SCOPE_RE.test(scope)) {
    return textResult({ error: `Invalid kv scope id: ${scope}` }, true);
  }
  const value = await kvGet(scope, name);
  return textResult({ scope, name, found: value !== undefined, value: value ?? null });
}

async function kvSetTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : 'global';
  const value = typeof args.value === 'string' ? args.value : args.value == null ? '' : String(args.value);
  if (!KV_KEY_RE.test(name)) {
    return textResult({ error: 'kv_set requires a valid "name" (letters, digits, _ and -, not starting with a digit).' }, true);
  }
  if (!KV_SCOPE_RE.test(scope)) {
    return textResult({ error: `Invalid kv scope id: ${scope}` }, true);
  }
  const res = await kvSet(scope, name, value);
  if ('skipped' in res) {
    return textResult({ scope, name, saved: false, skipped: res.skipped }, true);
  }
  return textResult({ scope, name, saved: true, size: res.size });
}

async function createTicketForHumanTool(args: Record<string, unknown>, source: ToolCallSource): Promise<CallToolResult> {
  const input = {
    message: args.message,
    labels: args.labels,
    title: args.title,
    conversationId: args.conversation_id,
    messageId: args.message_id,
    flowId: args.flow_id,
    nodeId: args.node_id,
    source: source === 'host' ? 'host' : 'agent',
  };
  const parsed = CreateTicketInputSchema.safeParse(input);
  if (!parsed.success) return textResult({ error: 'A non-empty ticket message and valid optional context are required.' }, true);
  const result = await ticketService.createTicket(parsed.data);
  return result.success && result.ticket
    ? textResult({ created: true, id: result.ticket.id, labels: result.ticket.labels })
    : textResult({ error: result.error ?? 'Unable to create ticket.' }, true);
}

function proposeUiAction(args: Record<string, unknown>): CallToolResult {
  const type = args.type === 'highlight' || args.type === 'set_value' ? args.type : null;
  const rawTarget = args.target && typeof args.target === 'object'
    ? args.target as Record<string, unknown>
    : null;
  const kind = typeof rawTarget?.kind === 'string' ? rawTarget.kind.trim() : '';
  if (!type || !kind || (type === 'set_value' && !('value' in args))) {
    return textResult({
      error: 'propose_ui_action requires a valid type, target.kind, and a value for set_value.',
    }, true);
  }
  const target = {
    kind,
    ...(typeof rawTarget?.id === 'string' ? { id: rawTarget.id } : {}),
    ...(typeof rawTarget?.field === 'string' ? { field: rawTarget.field } : {}),
    ...(typeof rawTarget?.path === 'string' ? { path: rawTarget.path } : {}),
  };
  return textResult({
    type: 'flujo_ui_action',
    accepted: true,
    action: {
      type,
      target,
      ...('value' in args ? { value: args.value } : {}),
      ...(typeof args.label === 'string' ? { label: args.label.slice(0, 160) } : {}),
      ...(typeof args.evidence === 'string' ? { evidence: args.evidence.slice(0, 2000) } : {}),
    },
    note: type === 'set_value'
      ? 'The browser will show an Apply control; no value changed yet.'
      : 'The browser will validate and highlight the target.',
  });
}

/**
 * Dispatch one internal-server tool call. Always resolves to a CallToolResult
 * (errors become isError results, mirroring how a real MCP server responds).
 */
export async function internalCallTool(
  service: InternalDispatchService,
  toolName: string,
  args: Record<string, unknown>,
  source: ToolCallSource = 'host',
): Promise<CallToolResult> {
  try {
    if (isAuthoringTool(toolName)) {
      return await authoringCallTool(toolName, args);
    }
    switch (toolName) {
      case 'propose_ui_action':
        return proposeUiAction(args);
      case 'create_ticket_for_human':
        return await createTicketForHumanTool(args, source);
      case 'list_flows':
        return await listFlows(args);
      case 'discover_capabilities':
        return await discoverCapabilities(service, args, source);
      case 'execute_flow':
        return await executeFlow(args);
      case 'explain_flow':
        return await explainFlow(args);
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
        return await listMcpServers(service, args);
      case 'list_mcp_server_tools':
        return await listMcpServerTools(service, args, source);
      case 'call_mcp_tool':
        return await callMcpTool(service, args, source);
      case 'restart_mcp_server':
        return await restartMcpServer(service, args);
      case 'set_mcp_server_enabled':
        return await setMcpServerEnabled(service, args);
      case 'system_screenshot':
        return await systemScreenshotHandler(args);
      case 'list_models':
        return await listModels(args);
      case 'list_planned_executions':
        return await listPlannedExecutions(args);
      case 'run_planned_execution':
        return await runPlannedExecution(args);
      case 'update_planned_execution':
        return await updatePlannedExecution(args);
      case 'create_planned_execution':
        return await createPlannedExecution(args);
      case 'delete_planned_execution':
        return await deletePlannedExecution(args);
      case 'list_conversations':
        return await listConversations(args);
      case 'read_conversation':
        return await readConversation(args);
      case 'kv_get':
        return await kvGetTool(args);
      case 'kv_set':
        return await kvSetTool(args);
      default:
        return textResult({ error: `Unknown FLUJO control-plane tool: ${toolName}` }, true);
    }
  } catch (err) {
    log.error('internalCallTool failed', { toolName, err });
    return textResult(
      { error: `Tool failed: ${err instanceof Error ? err.message : String(err)}` },
      true
    );
  }
}
