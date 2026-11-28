/**
 * Flows-as-MCP-tools brain for FLUJO's control-plane MCP package (issue #38, Item D).
 *
 * This is the transport-agnostic logic behind `/mcp`: it lists every saved Flow
 * as an MCP tool and, on `tools/call`, runs the chosen flow through the existing
 * execution keystone (`runFlow`) and returns its output. The inbound HTTP/MCP
 * shell lives in the route handler (mirroring the `/mcp-proxy/<server>` split),
 * so this module stays small and unit-testable.
 *
 * Design decisions (confirmed for #38):
 *  - Transport: streamable-HTTP; exposure: localhost-only, no auth (v1 posture,
 *    same as the per-server proxy).
 *  - Every saved flow is exposed. Tool name = slug(flow name) with deterministic
 *    collision suffixes; description reuses Item A's synthesizer (a user-authored
 *    flow description wins verbatim); inputSchema = a single `input` string that
 *    is sent to the flow as the user message.
 *  - Runs are ephemeral (mode: 'ephemeral'): a tools/call never pollutes the chat
 *    sidebar or the conversations store. A flow that may wait for a person (a Human
 *    step or a step approval) runs saved instead, so it can stop and come back (#1095).
 *    When it stops, the caller gets the conversation that waits: an MCP task follows
 *    it (input_required, then the result), a plain call gets a clear hand-over text.
 */
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { flowService } from '@/backend/services/flow/index';
import { buildFlowToolNameMap } from '@/shared/utils/flowToolNaming';
import { buildFlowToolDescription } from '@/backend/execution/flow/buildHandoffDescription';
import { randomUUID } from 'node:crypto';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { flowMayWaitForPerson } from '@/utils/shared/flowApproval';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { waitingHandoffText } from './flowToolContinuations';
import { ElicitResultV2Schema, type InputRequestsV2, type InputResponsesV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

const log = createLogger('backend/services/mcp/flowTools');

/** JSON Schema for a flow tool's input: one free-text message sent to the flow. */
function flowInputSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The message / prompt to send to the flow as the user turn.',
      },
      confirm: {
        type: 'boolean',
        description: 'Request confirmation before running. Requires negotiated MCP Tasks with form elicitation support.',
        default: false,
      },
    },
    required: ['input'],
  };
}

/**
 * List every saved flow as an MCP tool. Descriptions are synthesised from what
 * each flow actually contains (Item A synthesizer). A synthesis failure for one
 * flow degrades to a minimal description rather than dropping the tool.
 */
export async function flowToolsListTools(): Promise<{ tools: Tool[] }> {
  const flows = await flowService.loadFlows();
  const nameMap = buildFlowToolNameMap(flows.map((f) => ({ id: f.id, name: f.name })));

  const tools: Tool[] = [];
  for (const flow of flows) {
    const name = nameMap.get(flow.id);
    if (!name) continue; // defensive; every id is mapped above
    let description: string;
    try {
      description = await buildFlowToolDescription(flow);
    } catch (err) {
      log.warn('Failed to build flow tool description; using minimal fallback', { flow: flow.name, err });
      description = `Runs the FLUJO flow "${flow.name}".`;
    }
    tools.push({ name, description, inputSchema: flowInputSchema() });
  }

  log.debug('Listed flow tools', { count: tools.length });
  return { tools };
}

/** Extract the `input` string from tools/call arguments, tolerating loose shapes. */
function extractInput(args: Record<string, unknown>): string {
  const raw = args?.input;
  if (typeof raw === 'string') return raw;
  if (raw != null) return String(raw);
  return '';
}

/**
 * Run the flow bound to `toolName` and return its output as an MCP tool result.
 * The flow is resolved by rebuilding the same deterministic name map used by
 * `flowToolsListTools`, so list and call always agree. Runs are ephemeral.
 */
export interface FlowToolExecutionOptions {
  abortSignal?: AbortSignal;
  assertAuthorized?: () => Promise<void>;
  requestInput?: (requests: InputRequestsV2) => Promise<InputResponsesV2>;
}

export async function flowToolsCallTool(
  toolName: string,
  args: Record<string, unknown>,
  options: FlowToolExecutionOptions = {},
): Promise<CallToolResult> {
  return (await runFlowTool(toolName, args, options)).result;
}

/** What a flow tool call produced; `waitingIn` names the saved run that now waits for a person. */
export interface FlowToolRun {
  result: CallToolResult;
  waitingIn?: string;
}

export async function runFlowTool(
  toolName: string,
  args: Record<string, unknown>,
  options: FlowToolExecutionOptions = {},
): Promise<FlowToolRun> {
  const done = (result: CallToolResult): FlowToolRun => ({ result });
  const assertCurrent = async () => {
    options.abortSignal?.throwIfAborted();
    await options.assertAuthorized?.();
    options.abortSignal?.throwIfAborted();
  };
  await assertCurrent();
  const flows = await flowService.loadFlows();
  await assertCurrent();
  const nameMap = buildFlowToolNameMap(flows.map((f) => ({ id: f.id, name: f.name })));

  let flowId: string | undefined;
  for (const [id, name] of nameMap.entries()) {
    if (name === toolName) {
      flowId = id;
      break;
    }
  }

  if (!flowId) {
    log.warn('tools/call for unknown flow tool', { toolName });
    return done({
      content: [{ type: 'text', text: `Error: no flow is exposed as tool '${toolName}'.` }],
      isError: true,
    });
  }
  // A flow that may wait for a person runs saved, so its wait survives a restart.
  const saved = !getHarnessExecution() && await flowMayWaitForPerson(flows.find((flow) => flow.id === flowId),
    async (id) => flows.find((flow) => flow.id === id));
  const conversationId = saved ? randomUUID() : undefined;

  const input = extractInput(args);

  try {
    if (args.confirm === true) {
      if (!options.requestInput) return done({
        content: [{ type: 'text', text: 'Confirmation requires negotiated MCP Tasks and form elicitation.' }], isError: true,
      });
      const responses = await options.requestInput({ confirmation: {
        method: 'elicitation/create',
        params: {
          mode: 'form', message: `Run the FLUJO flow '${toolName}'?`,
          requestedSchema: { type: 'object', properties: {
            confirmed: { type: 'boolean', title: 'Run this flow' },
          }, required: ['confirmed'] },
        },
      } });
      await assertCurrent();
      const response = ElicitResultV2Schema.parse(responses.confirmation);
      if (response.action !== 'accept' || response.content?.confirmed !== true) return done({
        content: [{ type: 'text', text: 'Flow execution declined.' }],
      });
    }
    await assertCurrent();
    const result = await runFlow({
      flowId,
      prompt: input,
      source: 'mcp',
      mode: saved ? 'conversation' : 'ephemeral',
      ...(conversationId ? { conversationId, userTurn: true } : {}),
      flujo: true,
      requireApproval: false,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.assertAuthorized ? { executionAuthority: {
        signal: options.abortSignal ?? new AbortController().signal,
        assertCurrent,
      } } : {}),
    });
    await assertCurrent();

    if (result.flowNotFound) {
      return done({
        content: [{ type: 'text', text: `Error: flow not found: ${result.flowNotFound.name}` }],
        isError: true,
      });
    }

    if (result.status === 'error') {
      const message = result.error?.message ?? 'Unknown error during flow execution.';
      return done({
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      });
    }

    if (result.status === 'awaiting_tool_approval' && conversationId) {
      // Saved and stopped for a person: never an empty success. The run goes on in FLUJO,
      // under FLUJO's own authority, so this call's authority must not stay on it.
      const live = FlowExecutor.conversationStates.get(conversationId);
      if (live) delete live.executionAuthority;
      const handoff = waitingHandoffText(conversationId, result.sharedState);
      return {
        waitingIn: conversationId,
        result: {
          content: [{ type: 'text', text: handoff.text }],
          structuredContent: handoff.structured,
        },
      };
    }

    return done({
      content: [{ type: 'text', text: result.outputText ?? '' }],
    });
  } catch (err) {
    // Authority loss/cancellation must retire the job, never look like success.
    await assertCurrent();
    log.error('flowToolsCallTool failed', { toolName, flowId, err });
    return done({
      content: [{ type: 'text', text: `Error running flow: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    });
  }
}
