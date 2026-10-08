import {
  McpGetSkillResultSchema,
  McpListSkillsResultSchema,
} from './skills.js';

// This is a distinct child-process capability, never an owner credential.
const workloadCredential = (() => {
  const token = process.env.FLUJO_MCP_WORKLOAD_TOKEN;
  const audience = process.env.FLUJO_MCP_WORKLOAD_AUDIENCE;
  if (token === undefined && audience === undefined) return undefined;
  if (process.env.FLUJO_WORKER_MODE === '1' || !token || !/^flo_mcp1_[A-Za-z0-9_-]{43}$/.test(token)
      || !audience) throw new Error('Invalid bundled FLUJO workload credentials.');
  const url = new URL(audience);
  if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.origin !== audience || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('The bundled FLUJO workload audience must be an exact loopback origin.');
  }
  const workspace = process.env.FLUJO_WORKSPACE;
  if (!workspace || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) {
    throw new Error('Invalid bundled FLUJO workload workspace.');
  }
  return Object.freeze({ token, audience, workspace });
})();

export type FlujoOperation =
  | 'listTools'
  | 'callTool'
  | 'listResources'
  | 'listResourceTemplates'
  | 'readResource'
  | 'listSkills'
  | 'getSkill';

type FlujoPayload = {
  name?: string;
  args?: Record<string, unknown>;
  uri?: string;
  cursor?: string;
  skillUri?: string;
};

const AUTHORING_TOOLS = new Set([
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
]);
const FLOW_TOOLS = new Set([
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
]);
const SERVER_TOOLS = new Set([
  'list_mcp_servers',
  'list_mcp_server_tools',
  'call_mcp_tool',
  'restart_mcp_server',
  'set_mcp_server_enabled',
  'system_screenshot',
]);
const AUTOMATION_TOOLS = new Set([
  'list_models',
  'list_planned_executions',
  'run_planned_execution',
  'update_planned_execution',
  'create_planned_execution',
  'delete_planned_execution',
  'create_ticket_for_human',
]);
const STATE_TOOLS = new Set([
  'list_conversations',
  'read_conversation',
  'kv_get',
  'kv_set',
]);

export function flujoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLUJO_BASE_URL?.trim();
  const base = configured || 'http://127.0.0.1:4200';
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 47) end -= 1;
  const result = base.slice(0, end);
  if (env.FLUJO_WORKER_MODE === '1') {
    const url = new URL(result);
    if (!['http:', 'https:'].includes(url.protocol)
        || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) {
      throw new Error('The worker FLUJO MCP client requires a loopback FLUJO_BASE_URL.');
    }
  }
  return result;
}

export function flujoWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLUJO_WORKSPACE?.trim();
  return configured && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(configured)
    ? configured
    : 'default-workspace';
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
  // Fresh package and private-authority fences run throughout authenticated requests.
  timeoutMs = workloadCredential ? 120_000 : 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const baseUrl = flujoBaseUrl();
    if (workloadCredential) {
      if (baseUrl !== workloadCredential.audience || process.env.FLUJO_WORKER_MODE === '1'
          || process.env.FLUJO_WORKSPACE !== workloadCredential.workspace) {
        throw new Error('Bundled FLUJO workload destination or workspace changed.');
      }
    } else if (process.env.FLUJO_MCP_WORKLOAD_TOKEN !== undefined || process.env.FLUJO_MCP_WORKLOAD_AUDIENCE !== undefined) {
      throw new Error('Bundled FLUJO workload credentials must be configured before client initialization.');
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-flujo-workspace': flujoWorkspace(),
      ...(process.env.FLUJO_WORKER_MODE === '1' && process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN
        ? { authorization: `Bearer ${process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    };
    if (workloadCredential) {
      headers.authorization = `Bearer ${workloadCredential.token}`;
      headers['x-flujo-workspace'] = workloadCredential.workspace;
    }
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
      ...(workloadCredential ? { redirect: 'error' as const } : {}),
      headers,
    } as RequestInit);
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
  if (operation === 'listSkills') {
    const result = await requestJson<unknown>('/api/mcp/flujo/skills');
    return McpListSkillsResultSchema.parse(result) as T;
  }
  if (operation === 'getSkill') {
    const uri = payload.skillUri?.trim();
    if (!uri) throw new Error('A standalone MCP Skill URI is required.');
    const result = await requestJson<unknown>('/api/mcp/flujo/skills', {
      method: 'POST',
      body: JSON.stringify({ uri }),
    });
    return McpGetSkillResultSchema.parse(result) as T;
  }

  const name = payload.name?.trim() ?? '';
  if (!name) throw new Error('A FLUJO tool name is required.');
  const requestedTimeout = Number(payload.args?.timeout);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(workloadCredential ? 120_000 : 30_000, Math.ceil(requestedTimeout * 1000) + 5_000)
    : workloadCredential ? 120_000 : 30_000;
  return requestJson<T>(toolRoute(name), {
    method: 'POST',
    body: JSON.stringify({ name, args: payload.args ?? {} }),
  }, timeoutMs);
}
