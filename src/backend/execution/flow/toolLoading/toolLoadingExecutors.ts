import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import type { MCPNodeReference, ToolDefinition } from '../types';
import type { DecodedTool } from '../handlers/toolNamespace';
import type { ToolApprovalCall } from '../toolApprovalGate';
import {
  isCallToolName,
  isSearchToolsName,
  normalizeToolSearchRequest,
  searchDeferredTools,
} from './deferredTools';
import { invokeStepTool, type StepToolService } from './stepToolInvoker';
import {
  buildScriptBindings,
  isRunToolScriptName,
  scriptPathOf,
  type ScriptBinding,
} from '../codeMode/codeModeTool';
import { runToolScript, type ScriptLimits } from '../codeMode/sandbox';
import { combineAbortSignals } from '../combineAbortSignals';
import { isFlowExecutionAuthorityError } from '../executionAuthority';

const log = createLogger('backend/flow/execution/toolLoading/executors');

/**
 * What a step offers for deferred descriptions and code mode (#1448). Built by
 * ProcessNode.prep each turn; runtime only, never persisted.
 */
export interface StepToolCatalog {
  nodeId?: string;
  /** Every MCP tool the step offers after its filters, deferred or loaded. */
  tools: ToolDefinition[];
  /** `search_tools` is offered. */
  deferring: boolean;
  /** Found tools run through `call_tool` (the adapter owns its tool loop). */
  callThrough: boolean;
  /** `run_tool_script` is offered. */
  codeMode: boolean;
}

export interface ToolLoadingContext {
  /** Missing after a restart or resume: rebuilt from the step's tools then. */
  catalog?: StepToolCatalog;
  toolNameMap: Readonly<Record<string, DecodedTool>>;
  /** The step's offer list (SharedState.offeredToolNames), used when the catalog is missing. */
  offeredToolNames?: readonly string[];
  /** The step's MCP nodes, to rebuild tool descriptions when the catalog is missing. */
  mcpNodes?: readonly MCPNodeReference[];
  /** Records tools the model loaded, so the next turn offers their full description. */
  markToolsLoaded?: (names: readonly string[]) => void;
  /** The one approval gate for each tool a program or `call_tool` runs. */
  approve?: (call: ToolApprovalCall) => Promise<boolean>;
  service: StepToolService;
  conversationId?: string;
  runId?: string;
  nodeId?: string;
  signal?: AbortSignal;
  beforeToolDispatch?: () => Promise<void>;
  afterToolDispatch?: () => Promise<void>;
  authorizePersonaCoreMcp?: (serverName: string, nodeId?: string) => Promise<void>;
  /** Sizes the result limit for the model that reads the answer (#1226). */
  contextWindow?: number;
  /** The step's own result limit and where a moved answer is kept (#1226). */
  toolResults?: import('@/shared/toolResultLimit').StepToolResults;
  scriptLimits?: Partial<ScriptLimits>;
}

export interface ToolLoadingOutcome {
  success: boolean;
  /** JSON text for the tool message. */
  content: string;
}

/** The answer as a value for adapters that run their own loop: parsed JSON, or the text when a long answer was shortened. */
export function toolLoadingResultValue(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

export function isToolLoadingToolName(name: string): boolean {
  return isSearchToolsName(name) || isCallToolName(name) || isRunToolScriptName(name);
}

/** Model-facing names of the step's MCP tools. */
export function allowedStepToolNames(context: Pick<ToolLoadingContext, 'catalog' | 'toolNameMap' | 'offeredToolNames'>): Set<string> {
  if (context.catalog) return new Set(context.catalog.tools.map((tool) => tool.name));
  const mapped = Object.keys(context.toolNameMap);
  if (!context.offeredToolNames) return new Set(mapped);
  const offered = new Set(context.offeredToolNames);
  return new Set(mapped.filter((name) => offered.has(name)));
}

export function scriptBindingsFor(
  toolNameMap: Readonly<Record<string, DecodedTool>>,
  allowed: ReadonlySet<string>,
): ScriptBinding[] {
  return buildScriptBindings([...allowed]
    .filter((name) => Object.hasOwn(toolNameMap, name))
    .map((name) => ({ name, server: toolNameMap[name].server, tool: toolNameMap[name].tool })));
}

async function stepToolDefinitions(context: ToolLoadingContext, allowed: ReadonlySet<string>): Promise<ToolDefinition[]> {
  if (context.catalog) return context.catalog.tools;
  if (!context.mcpNodes?.length) return [];
  const { ToolHandler } = await import('../handlers/ToolHandler');
  const listed = await ToolHandler.processMCPNodes({ mcpNodes: [...context.mcpNodes] });
  if (!listed.success) throw new Error(listed.error.message);
  return listed.value.availableTools.filter((tool) => tool.server && allowed.has(tool.name));
}

function failure(error: string): ToolLoadingOutcome {
  return { success: false, content: JSON.stringify({ error }) };
}

async function executeSearchTools(args: Record<string, unknown>, context: ToolLoadingContext): Promise<ToolLoadingOutcome> {
  const request = normalizeToolSearchRequest(args);
  if (!request.query?.trim() && !request.names?.length) {
    return failure('Give `query` (words for what you need) or `names` (exact tool names from the list).');
  }
  const allowed = allowedStepToolNames(context);
  const definitions = await stepToolDefinitions(context, allowed);
  const matches = searchDeferredTools(definitions, request);
  const callThrough = context.catalog?.callThrough ?? false;
  const bindings = context.catalog?.codeMode
    ? new Map(scriptBindingsFor(context.toolNameMap, allowed).map((binding) => [binding.name, scriptPathOf(binding)]))
    : undefined;
  if (matches.length > 0) context.markToolsLoaded?.(matches.map((tool) => tool.name));
  return {
    success: true,
    content: JSON.stringify({
      tools: matches.map((tool) => ({
        name: tool.name,
        ...(tool.server ? { server: tool.server } : {}),
        ...(bindings?.get(tool.name) ? { scriptFunction: bindings.get(tool.name) } : {}),
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      })),
      note: matches.length === 0
        ? 'No tool matched. Try other words, or load a tool by its exact name from the list in this tool\'s description.'
        : callThrough
          ? 'Run these tools with call_tool.'
          : 'These tools are now loaded: call them directly.',
    }),
  };
}

async function executeCallTool(args: Record<string, unknown>, context: ToolLoadingContext): Promise<ToolLoadingOutcome> {
  if (typeof args.name !== 'string' || !args.name.trim()) return failure('Give the exact tool `name` to run.');
  const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
    ? args.arguments as Record<string, unknown>
    : {};
  const outcome = await invokeStepTool({ ...context, allowedNames: allowedStepToolNames(context) }, args.name.trim(), toolArgs);
  if (!outcome.ok) return failure(outcome.error);
  context.markToolsLoaded?.([outcome.name]);
  return { success: true, content: JSON.stringify(outcome.result) };
}

async function executeRunToolScript(args: Record<string, unknown>, context: ToolLoadingContext): Promise<ToolLoadingOutcome> {
  if (typeof args.code !== 'string' || !args.code.trim()) return failure('Give the program as `code`.');
  const allowed = allowedStepToolNames(context);
  // A run that lost its authority must stop, not hand the failure to the program.
  const stop = new AbortController();
  let authorityFailure: unknown;
  const run = await runToolScript({
    code: args.code,
    bindings: scriptBindingsFor(context.toolNameMap, allowed),
    signal: combineAbortSignals(context.signal, stop.signal),
    limits: context.scriptLimits,
    invoke: async (name, toolArgs) => {
      try {
        const outcome = await invokeStepTool({ ...context, allowedNames: allowed }, name, toolArgs);
        return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error };
      } catch (error) {
        if (isFlowExecutionAuthorityError(error)) {
          authorityFailure ??= error;
          stop.abort(error);
        }
        log.warn('A program tool call failed before it returned', { name });
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  if (authorityFailure) throw authorityFailure;
  const calls = run.calls.map((call) => ({ tool: context.toolNameMap[call.name]?.tool ?? call.name, ok: call.ok }));
  const body = {
    ok: run.ok,
    ...(run.ok ? { result: run.result ?? null } : { error: run.error }),
    ...(run.logs ? { logs: run.logs } : {}),
    ...(run.logsTrimmed ? { logsTrimmed: true } : {}),
    calls,
    seconds: Math.round(run.durationMs / 100) / 10,
  };
  return { success: run.ok, content: JSON.stringify(body) };
}

/** Keep an answer within the tool result limit, storing the full text as a run resource when it is too long. */
async function bounded(content: string, name: string, context: ToolLoadingContext): Promise<string> {
  const store = context.toolResults?.store ?? context.conversationId;
  if (!store) return content;
  try {
    const [{ boundToolResult }, { getRunResourceSettings }] = await Promise.all([
      import('@/backend/services/runResources/boundToolResult'),
      import('@/backend/services/runResources'),
    ]);
    const result = await boundToolResult({
      conversationId: store,
      toolCallId: `${name}_${uuidv4()}`,
      toolName: name,
      nodeId: context.nodeId,
      content,
      settings: await getRunResourceSettings(),
      contextWindow: context.contextWindow,
      limit: context.toolResults?.limit,
    });
    return result.content;
  } catch (error) {
    log.warn('Could not apply the tool result limit; keeping the full answer', { name, error });
    return content;
  }
}

export async function executeToolLoadingTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolLoadingContext,
): Promise<ToolLoadingOutcome> {
  let outcome: ToolLoadingOutcome;
  if (isSearchToolsName(name)) outcome = await executeSearchTools(args, context);
  else if (isCallToolName(name)) outcome = await executeCallTool(args, context);
  else if (isRunToolScriptName(name)) outcome = await executeRunToolScript(args, context);
  else return failure(`Unknown tool "${name}".`);
  return { ...outcome, content: await bounded(outcome.content, name, context) };
}
