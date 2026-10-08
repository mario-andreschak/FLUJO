import type { NextRequest } from 'next/server';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { json } from '@/app/api/mcp/_helpers';

const log = createLogger('backend/services/mcp/flujoControlApi');

export const FLUJO_AUTHORING_TOOLS = [
  'list_flow_building_blocks',
  'get_flow_authoring_guide',
  'validate_flow_spec',
  'draft_flow',
  'draft_generated_flow',
  'create_flow',
  'suggest_tools_for_flow_step',
  'apply_tools_to_flow_step',
  'check_flow_plausibility',
  'find_mcp_server',
  'find_best_mcp_server',
  'install_mcp_server',
  'install_best_mcp_server',
  'read_persona_composition',
  'update_persona_composition',
] as const;

export const FLUJO_FLOW_TOOLS = [
  'propose_ui_action',
  'list_flows',
  'discover_capabilities',
  'execute_flow',
  'explain_flow',
  'read_flow',
  'update_flow',
  'list_flow_versions',
  'read_flow_version',
  'revert_flow',
  'delete_flow',
] as const;

export const FLUJO_SERVER_TOOLS = [
  'list_mcp_servers',
  'list_mcp_server_tools',
  'call_mcp_tool',
  'restart_mcp_server',
  'set_mcp_server_enabled',
  'system_screenshot',
] as const;

export const FLUJO_AUTOMATION_TOOLS = [
  'list_models',
  'list_planned_executions',
  'run_planned_execution',
  'update_planned_execution',
  'create_planned_execution',
  'delete_planned_execution',
  'create_ticket_for_human',
] as const;

export const FLUJO_STATE_TOOLS = [
  'list_conversations',
  'read_conversation',
  'kv_get',
  'kv_set',
] as const;

type FlujoToolName =
  | (typeof FLUJO_AUTHORING_TOOLS)[number]
  | (typeof FLUJO_FLOW_TOOLS)[number]
  | (typeof FLUJO_SERVER_TOOLS)[number]
  | (typeof FLUJO_AUTOMATION_TOOLS)[number]
  | (typeof FLUJO_STATE_TOOLS)[number];

type ToolRequestBody = {
  name?: unknown;
  args?: unknown;
};

/**
 * Domain-scoped HTTP adapter used by the standalone mcp-flujo process.
 *
 * Each route passes a closed allowlist. This intentionally is not an arbitrary
 * internal-service or MCP dispatcher endpoint: adding a tool requires assigning
 * it to a named domain route and reviewing that route's boundary.
 */
export async function handleFlujoToolRequest(
  request: NextRequest,
  allowedTools: readonly FlujoToolName[],
): Promise<Response> {
  const lock = await assertUnlocked();
  if (lock) return lock;

  let body: ToolRequestBody;
  try {
    body = (await request.json()) as ToolRequestBody;
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || !(allowedTools as readonly string[]).includes(name)) {
    return json({ error: 'Unknown or unavailable tool for this control endpoint.' }, 404);
  }
  if (body.args !== undefined && (!body.args || typeof body.args !== 'object' || Array.isArray(body.args))) {
    return json({ error: '"args" must be an object.' }, 400);
  }

  try {
    // Dynamic imports preserve MCPService's initialization boundary and keep all
    // validation, redaction, recursion/cadence limits, and orchestration in the
    // existing authoritative implementation.
    const [{ mcpService }, { internalCallTool }] = await Promise.all([
      import('@/backend/services/mcp'),
      import('@/backend/services/mcp/internalTools'),
    ]);
    const result: CallToolResult = await internalCallTool(
      mcpService,
      name,
      (body.args ?? {}) as Record<string, unknown>,
      'host',
    );
    return json(result, 200);
  } catch (error) {
    log.error('FLUJO control tool failed', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'The FLUJO control operation failed.' }, 500);
  }
}
