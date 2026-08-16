/**
 * The general-purpose Agent shipped with a fresh FLUJO workspace.
 *
 * Keep this definition deliberately neutral: the user chooses the model and
 * supplies the conversation prompt. The Process node starts with a deliberate
 * allowlist from each of the four shipped MCP servers.
 */
import type { Flow } from '@/shared/types/flow';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { flowService } from './index';

export const DEFAULT_FLUJO_AGENT_ID = 'default-agent-flujo';
export const DEFAULT_FLUJO_AGENT_VERSION = 2;
export const DEFAULT_FLUJO_AGENT_SERVERS = [
  'bash',
  'browser',
  'filesystem',
  'flujo',
] as const;
export const DEFAULT_FLUJO_AGENT_TOOLS = {
  bash: [
    'run',
    'start',
    'status',
    'sleep',
    'wait',
    'kill',
    'list_sessions',
    'write_stdin',
  ],
  browser: [
    'browser_open',
    'browser_navigate',
    'browser_close',
    'browser_click',
    'browser_type',
    'browser_scroll',
    'browser_snapshot',
    'browser_screenshot',
  ],
  filesystem: [
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'file_browser_ui',
    'dir_tree',
    'search',
    'get_file_info',
    'create_directory',
    'move',
    'delete',
    'get_allowed_directories',
  ],
  flujo: [
    'list_models',
    'list_flows',
    'read_flow',
    'explain_flow',
    'update_flow',
    'execute_flow',
    'list_planned_executions',
    'list_conversations',
    'list_mcp_servers',
    'list_mcp_server_tools',
    'call_mcp_tool',
    'discover_capabilities',
    'find_mcp_server',
    'find_best_mcp_server',
  ],
} as const satisfies Record<
  (typeof DEFAULT_FLUJO_AGENT_SERVERS)[number],
  readonly string[]
>;

function selectedServerTools(name: (typeof DEFAULT_FLUJO_AGENT_SERVERS)[number]): string[] {
  return [...DEFAULT_FLUJO_AGENT_TOOLS[name]];
}

/** Build the bundled definition without reading or writing storage. */
export function buildDefaultFlujoAgent(): Flow {
  const compiled = compileFlowSpec(
    {
      name: 'FLUJO',
      nodes: [
        { key: 'start', type: 'start', label: 'Start Node' },
        {
          key: 'process',
          type: 'process',
          label: 'Process Node',
          inputMode: 'full-history',
          servers: DEFAULT_FLUJO_AGENT_SERVERS.map((name) => ({
            name,
            tools: selectedServerTools(name),
          })),
        },
        { key: 'finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'process' },
        { from: 'process', to: 'finish' },
      ],
    },
    {
      servers: DEFAULT_FLUJO_AGENT_SERVERS.map((name) => ({ name })),
    },
  );

  if (!compiled.flow) {
    throw new Error('Bundled FLUJO Agent could not be compiled');
  }

  compiled.flow.id = DEFAULT_FLUJO_AGENT_ID;
  compiled.flow.name = 'FLUJO';
  compiled.flow.favorite = true;
  const process = compiled.flow.nodes.find((node) => node.type === 'process');
  if (!process) throw new Error('Bundled FLUJO Agent is missing its Process node');
  process.data.properties = {
    ...(process.data.properties ?? {}),
    defaultAgentVersion: DEFAULT_FLUJO_AGENT_VERSION,
  };
  return compiled.flow;
}

/**
 * Upgrade the brief v1 definition, which shipped with four bound servers but
 * empty tool allowlists. Preserve node IDs, prompts, model selection, and every
 * other user-authored field; a non-empty tool selection is treated as an edit
 * and is never replaced.
 */
function upgradeToollessDefaultAgent(flow: Flow): Flow | null {
  const process = flow.nodes.find((node) => node.type === 'process');
  if (!process) return null;
  const version = Number(process.data.properties?.defaultAgentVersion ?? 0);
  if (version >= DEFAULT_FLUJO_AGENT_VERSION) return null;

  const mcpNodes = flow.nodes.filter((node) => node.type === 'mcp');
  const byServer = new Map(mcpNodes.map((node) => [
    String(node.data.properties?.boundServer ?? ''),
    node,
  ]));
  const oldBindings = DEFAULT_FLUJO_AGENT_SERVERS.map((name) => byServer.get(name));
  if (
    oldBindings.some((node) => !node)
    || oldBindings.some((node) => {
      const enabled = node?.data.properties?.enabledTools;
      return !Array.isArray(enabled) || enabled.length > 0;
    })
  ) {
    return null;
  }

  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.id === process.id) {
        return {
          ...node,
          data: {
            ...node.data,
            properties: {
              ...(node.data.properties ?? {}),
              defaultAgentVersion: DEFAULT_FLUJO_AGENT_VERSION,
            },
          },
        };
      }
      const server = String(node.data.properties?.boundServer ?? '') as
        (typeof DEFAULT_FLUJO_AGENT_SERVERS)[number];
      if (!DEFAULT_FLUJO_AGENT_SERVERS.includes(server)) return node;
      return {
        ...node,
        data: {
          ...node.data,
          properties: {
            ...(node.data.properties ?? {}),
            enabledTools: selectedServerTools(server),
          },
        },
      };
    }),
  };
}

/** Seed the shipped Agent when missing and apply narrow bundled-version repairs. */
export async function ensureDefaultFlujoAgent(): Promise<Flow> {
  const existing = await flowService.getFlow(DEFAULT_FLUJO_AGENT_ID);
  if (existing) {
    const upgraded = upgradeToollessDefaultAgent(existing);
    if (!upgraded) return existing;
    const saved = await flowService.saveFlow(upgraded);
    if (!saved.success) {
      throw new Error(saved.error ?? 'Failed to enable the default FLUJO Agent tools');
    }
    return upgraded;
  }

  const bundled = buildDefaultFlujoAgent();
  const saved = await flowService.saveFlow(bundled);
  if (!saved.success) {
    throw new Error(saved.error ?? 'Failed to seed the default FLUJO Agent');
  }
  return bundled;
}
