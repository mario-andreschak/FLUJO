export type FlujoOperation =
  | 'listTools'
  | 'callTool'
  | 'listResources'
  | 'listResourceTemplates'
  | 'readResource';

type FlujoPayload = {
  name?: string;
  args?: Record<string, unknown>;
  uri?: string;
  cursor?: string;
};

const AUTHORING_TOOLS = new Set([
  'list_flow_building_blocks',
  'get_flow_authoring_guide',
  'validate_flow_spec',
  'draft_flow',
  'create_flow',
  'suggest_tools_for_flow_step',
  'apply_tools_to_flow_step',
  'check_flow_plausibility',
  'search_mcp_marketplace',
  'install_mcp_server',
  'install_best_mcp_server',
]);
const FLOW_TOOLS = new Set([
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
]);
const SERVER_TOOLS = new Set([
  'list_mcp_servers',
  'list_mcp_server_tools',
  'call_mcp_tool',
  'restart_mcp_server',
  'set_mcp_server_enabled',
]);
const AUTOMATION_TOOLS = new Set([
  'list_models',
  'list_planned_executions',
  'run_planned_execution',
  'update_planned_execution',
  'create_planned_execution',
  'delete_planned_execution',
]);
const STATE_TOOLS = new Set([
  'list_conversations',
  'read_conversation',
  'kv_get',
  'kv_set',
]);

export function flujoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLUJO_BASE_URL?.trim();
  return (configured || 'http://127.0.0.1:4200').replace(/\/+$/, '');
}

export function toolRoute(name: string): string {
  if (AUTHORING_TOOLS.has(name)) return '/api/mcp/flujo/authoring';
  if (FLOW_TOOLS.has(name)) return '/api/mcp/flujo/flows';
  if (SERVER_TOOLS.has(name)) return '/api/mcp/flujo/servers';
  if (AUTOMATION_TOOLS.has(name)) return '/api/mcp/flujo/automation';
  if (STATE_TOOLS.has(name)) return '/api/mcp/flujo/state';
  throw new Error(`Unknown FLUJO tool: ${name}`);
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(`${flujoBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`FLUJO returned a non-JSON response (${response.status}).`);
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `FLUJO request failed (${response.status}).`;
      throw new Error(message);
    }
    return body as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`FLUJO request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Typed HTTP transport for the stateless standalone mcp-flujo process. */
export async function flujoRequest<T>(
  operation: FlujoOperation,
  payload: FlujoPayload = {},
): Promise<T> {
  if (operation === 'listTools') {
    return requestJson<T>('/api/mcp/flujo/tools');
  }
  if (operation === 'listResources' || operation === 'listResourceTemplates') {
    const result = await requestJson<{
      resources: unknown[];
      resourceTemplates: unknown[];
      error?: string;
      nextCursor?: string;
    }>(`/api/mcp/flujo/resources${payload.cursor ? `?cursor=${encodeURIComponent(payload.cursor)}` : ''}`);
    if (operation === 'listResources') {
      return {
        resources: result.resources,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...(result.error ? { error: result.error } : {}),
      } as T;
    }
    return {
      resourceTemplates: result.resourceTemplates,
      ...(result.error ? { error: result.error } : {}),
    } as T;
  }
  if (operation === 'readResource') {
    return requestJson<T>('/api/mcp/flujo/resources/read', {
      method: 'POST',
      body: JSON.stringify({ uri: payload.uri }),
    });
  }

  const name = payload.name?.trim() ?? '';
  if (!name) throw new Error('A FLUJO tool name is required.');
  const requestedTimeout = Number(payload.args?.timeout);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(30_000, Math.ceil(requestedTimeout * 1000) + 5_000)
    : 30_000;
  return requestJson<T>(toolRoute(name), {
    method: 'POST',
    body: JSON.stringify({ name, args: payload.args ?? {} }),
  }, timeoutMs);
}
