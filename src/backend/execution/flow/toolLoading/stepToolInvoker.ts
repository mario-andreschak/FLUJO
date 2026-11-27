import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServiceResponse } from '@/shared/types/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { ownerScopeForRun } from '@/backend/services/mcp/ownerScope';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { classifyStatisticsError, createStatisticsEvent, recordStatisticsEvent } from '@/backend/services/statistics';
import { assertToolIdentityFresh, type DecodedTool, type ToolIdentityService } from '../handlers/toolNamespace';
import { registerToolCall, releaseToolCall } from '../toolCancelRegistry';
import { combineAbortSignals } from '../combineAbortSignals';
import type { ToolApprovalCall } from '../toolApprovalGate';

/**
 * Runs one of the step's MCP tools for a code-mode program or `call_tool`
 * (#1448). It applies the same rules as a direct call from the model:
 *
 * - only tools the step offers (its per-tool filters), by model-facing name
 *   or, when unambiguous, by the tool's own MCP name;
 * - the one approval gate (`approve`, built by createLiveToolApproval), asked
 *   with the real tool name and arguments;
 * - fixed preset arguments, the run's authority checks, the advertised tool
 *   identity, the per-call timeout and Stop/cancel.
 */

export type StepToolService = ToolIdentityService & {
  callTool: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
    onProgress?: undefined,
    callerNodeId?: string,
    signal?: AbortSignal,
    source?: 'model',
    ownerScope?: string,
    trustedContext?: { conversationId: string },
  ) => Promise<MCPServiceResponse>;
};

export interface StepToolInvokerOptions {
  toolNameMap: Readonly<Record<string, DecodedTool>>;
  /** Model-facing names of the MCP tools this step offers, deferred or loaded. */
  allowedNames: ReadonlySet<string>;
  /** The approval gate. Missing means no call in this run needs a person. */
  approve?: (call: ToolApprovalCall) => Promise<boolean>;
  service: StepToolService;
  conversationId?: string;
  runId?: string;
  nodeId?: string;
  signal?: AbortSignal;
  beforeToolDispatch?: () => Promise<void>;
  afterToolDispatch?: () => Promise<void>;
  authorizePersonaCoreMcp?: (serverName: string, nodeId?: string) => Promise<void>;
}

export type StepToolOutcome =
  | { ok: true; name: string; value: unknown; result: CallToolResult }
  | { ok: false; name: string; error: string };

/** The model-facing name for `wanted`, matching the tool's MCP name only when that is unambiguous. */
export function resolveStepToolName(
  wanted: string,
  toolNameMap: Readonly<Record<string, DecodedTool>>,
  allowedNames: ReadonlySet<string>,
): { name: string } | { error: string } {
  if (allowedNames.has(wanted) && Object.hasOwn(toolNameMap, wanted)) return { name: wanted };
  const byOriginal = [...allowedNames].filter((name) => Object.hasOwn(toolNameMap, name) && toolNameMap[name].tool === wanted);
  if (byOriginal.length === 1) return { name: byOriginal[0] };
  if (byOriginal.length > 1) {
    return { error: `More than one server has a tool called "${wanted}". Use one of these names: ${byOriginal.join(', ')}.` };
  }
  return { error: `Tool "${wanted}" is not available in this step. Use only the tools offered for this step.` };
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * What a program receives: the structured result when the tool gives one,
 * else its text (parsed when it is JSON), else a plain list of its parts with
 * pictures and other binary data left out.
 */
export function scriptValueOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const parts = result.content ?? [];
  if (parts.length > 0 && parts.every((part) => part.type === 'text')) {
    const text = textOf(result);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
    return text;
  }
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'resource_link') return { type: 'resource_link', uri: part.uri, name: part.name };
    const mimeType = 'mimeType' in part ? part.mimeType : undefined;
    return { type: part.type, mimeType, note: 'binary content left out of the program' };
  });
}

export async function invokeStepTool(
  options: StepToolInvokerOptions,
  wanted: string,
  args: Record<string, unknown>,
): Promise<StepToolOutcome> {
  const resolved = resolveStepToolName(wanted, options.toolNameMap, options.allowedNames);
  if ('error' in resolved) return { ok: false, name: wanted, error: resolved.error };
  const { name } = resolved;
  const decoded = options.toolNameMap[name];
  const callId = `call_${uuidv4()}`;

  if (options.signal?.aborted) return { ok: false, name, error: 'The run stopped before this call.' };
  if (options.approve) {
    let approved: boolean;
    try {
      approved = await options.approve({ id: callId, name, args });
    } catch (error) {
      return { ok: false, name, error: error instanceof Error ? error.message : String(error) };
    }
    if (!approved) return { ok: false, name, error: `The person did not approve "${name}", so it did not run.` };
  }

  const startedAt = Date.now();
  const effectiveArgs = await applyPresetArguments(args, decoded.presetArgs, decoded.context);
  await options.beforeToolDispatch?.();
  await options.authorizePersonaCoreMcp?.(decoded.server, decoded.nodeId);
  const freshness = assertToolIdentityFresh(name, decoded, options.service);
  if (!freshness.ok) return { ok: false, name, error: freshness.reason };

  const cancelScope = options.conversationId ?? options.runId;
  const perCall = cancelScope ? registerToolCall(cancelScope, callId) : undefined;
  let response: MCPServiceResponse;
  try {
    response = await options.service.callTool(
      decoded.server,
      decoded.tool,
      effectiveArgs,
      decoded.timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
      undefined,
      decoded.nodeId,
      combineAbortSignals(options.signal, perCall?.signal),
      'model',
      ownerScopeForRun({ runId: options.runId, conversationId: options.conversationId }),
      options.conversationId ? { conversationId: options.conversationId } : undefined,
    );
  } finally {
    if (cancelScope) releaseToolCall(cancelScope, callId);
  }
  await options.afterToolDispatch?.();

  const result = response.data as CallToolResult | undefined;
  const failed = !response.success || !result || result.isError === true;
  if (options.runId) {
    recordStatisticsEvent(createStatisticsEvent({
      type: 'tool.invocation',
      runId: options.runId,
      node: options.nodeId ? { id: options.nodeId } : undefined,
      tool: { id: decoded.tool, name: decoded.tool, kind: 'mcp' },
      provider: { id: decoded.server },
      outcome: failed ? 'error' : 'completed',
      durationMs: Math.max(0, Date.now() - startedAt),
      errorClass: failed ? classifyStatisticsError({ type: 'tool' }) : undefined,
    }));
  }
  if (!response.success || !result) {
    return { ok: false, name, error: response.error ?? `Tool "${name}" failed.` };
  }
  if (result.isError === true) {
    return { ok: false, name, error: textOf(result) || `Tool "${name}" reported an error.` };
  }
  return { ok: true, name, value: scriptValueOf(result), result };
}
