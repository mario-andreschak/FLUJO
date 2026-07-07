/**
 * Flows-as-MCP-tools brain for the built-in FLUJO MCP server (issue #38, Item D).
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
 *    sidebar or the conversations store.
 */
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { flowService } from '@/backend/services/flow/index';
import { buildFlowToolNameMap } from '@/shared/utils/flowToolNaming';
import { buildFlowToolDescription } from '@/backend/execution/flow/buildHandoffDescription';
import { runFlow } from '@/backend/execution/flow/runFlow';

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
export async function flowToolsCallTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const flows = await flowService.loadFlows();
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
    return {
      content: [{ type: 'text', text: `Error: no flow is exposed as tool '${toolName}'.` }],
      isError: true,
    };
  }

  const input = extractInput(args);

  try {
    const result = await runFlow({
      flowId,
      prompt: input,
      mode: 'ephemeral',
      flujo: true,
      requireApproval: false,
    });

    if (result.flowNotFound) {
      return {
        content: [{ type: 'text', text: `Error: flow not found: ${result.flowNotFound.name}` }],
        isError: true,
      };
    }

    if (result.status === 'error') {
      const message = result.error?.message ?? 'Unknown error during flow execution.';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: result.outputText ?? '' }],
    };
  } catch (err) {
    log.error('flowToolsCallTool failed', { toolName, flowId, err });
    return {
      content: [{ type: 'text', text: `Error running flow: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
