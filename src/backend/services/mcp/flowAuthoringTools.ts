/**
 * Flow-authoring tools for the built-in FLUJO MCP server (#14 follow-up:
 * FlowSpec as the public authoring contract).
 *
 * Alongside flows-as-tools (flowTools.ts), the `/mcp-flows` server exposes three
 * authoring tools so any external MCP client can CREATE flows without ever writing
 * raw ReactFlow JSON — the calling agent authors the semantic FlowSpec and FLUJO's
 * deterministic compiler does the rest:
 *
 *   - list_flow_building_blocks: what a spec may reference (models, servers+tools,
 *     existing flows) — call this FIRST.
 *   - validate_flow_spec: compile + validate without saving; returns the issues an
 *     agent iterates on.
 *   - create_flow: compile + validate + save. Saving is gated on zero validation
 *     errors, so the loop is: blocks → spec → validate → fix → create.
 *   - search_mcp_marketplace / install_mcp_server: capability acquisition for the
 *     brain / self-improvement track — an external agent can find and install NEW
 *     MCP servers (downloading + running third-party packages on this host) and
 *     wire them into the flows it authors. Localhost-only posture, same as the
 *     endpoint itself; the install tool's description carries the warning.
 *
 * Transport-agnostic like flowTools.ts; the route merges both tool sets (authoring
 * names are reserved — a flow whose slug collides is shadowed with a warning).
 */
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { gatherGenerationContext } from '@/backend/services/flow/generationContext';
import { searchRegistry, installRegistryServer } from '@/backend/services/mcp/registryInstall';

const log = createLogger('backend/services/mcp/flowAuthoringTools');

export const AUTHORING_TOOL_NAMES = [
  'list_flow_building_blocks',
  'validate_flow_spec',
  'create_flow',
  'search_mcp_marketplace',
  'install_mcp_server',
] as const;

export function isAuthoringTool(name: string): boolean {
  return (AUTHORING_TOOL_NAMES as readonly string[]).includes(name);
}

/** JSON Schema for the spec-taking tools: one object argument. */
function specInputSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'The FlowSpec object (see the tool description for the format).',
      },
    },
    required: ['spec'],
  };
}

export function authoringToolDefinitions(): Tool[] {
  return [
    {
      name: 'list_flow_building_blocks',
      description:
        'List everything a FlowSpec may reference in this FLUJO instance: configured models (bind to process steps), MCP servers and their tools (attach via "servers"), and existing flows (usable as subflow targets). Call this before authoring a spec.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'validate_flow_spec',
      description: `Compile and validate a FlowSpec WITHOUT saving. Returns the compiled flow's validation result (errors block saving; warnings are advisory) so you can iterate until clean, then call create_flow.\n\n${FLOWSPEC_DOC}`,
      inputSchema: specInputSchema(),
    },
    {
      name: 'create_flow',
      description: `Create a new FLUJO flow from a FlowSpec. The spec is compiled deterministically (layout, ids, and wiring are generated for you) and saved ONLY when validation finds zero errors — otherwise the issues are returned to fix. Use list_flow_building_blocks first to see the models, MCP servers/tools, and existing flows you may reference.\n\n${FLOWSPEC_DOC}`,
      inputSchema: specInputSchema(),
    },
    {
      name: 'search_mcp_marketplace',
      description:
        'Search the public MCP server registry for new capabilities (voice, browsing, files, email, vision, …). The registry matches the query against server NAMES only (substring) — use short single terms and try several. Returns name, description, whether FLUJO can install it, and which env vars/keys it would require.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short search term matched against server names.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'install_mcp_server',
      description:
        'Install an MCP server from the public registry (by the exact name returned by search_mcp_marketplace) and connect it — this DOWNLOADS AND RUNS a third-party package on the FLUJO host. Returns the FLUJO server name (reference it in FlowSpec "servers") and the tools it provides, or needsEnv when required keys are missing (supply values via the optional "env" argument, or pick a keyless alternative). First install can take minutes (package download).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact registry name from search results, e.g. "ai.keenable/web-search".' },
          env: {
            type: 'object',
            description: 'Optional env var values for the server (e.g. required API keys).',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['name'],
      },
    },
  ];
}

/** Tolerate the spec arriving as an object or a JSON string. */
function extractSpec(args: Record<string, unknown>): unknown {
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

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function authoringCallTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    if (toolName === 'list_flow_building_blocks') {
      const context = await gatherGenerationContext();
      return textResult(context.blocks);
    }

    if (toolName === 'search_mcp_marketplace') {
      const query = typeof args?.query === 'string' ? args.query : '';
      const hits = await searchRegistry(query);
      return textResult(hits);
    }

    if (toolName === 'install_mcp_server') {
      const name = typeof args?.name === 'string' ? args.name : '';
      const env =
        args?.env && typeof args.env === 'object' && !Array.isArray(args.env)
          ? (args.env as Record<string, string>)
          : undefined;
      const result = await installRegistryServer(name, env);
      return textResult(result, !result.installed);
    }

    if (toolName === 'validate_flow_spec' || toolName === 'create_flow') {
      const spec = extractSpec(args);
      if (!spec) {
        return textResult({ error: 'Provide a "spec" argument: a FlowSpec object (or a JSON string of one).' }, true);
      }
      const result = await compileSpec(spec, { save: toolName === 'create_flow' });
      if (!result.success) {
        return textResult({ error: result.error, issues: result.issues ?? [] }, true);
      }
      // A spec may nest inline child flows (subflowSpec), so a create can produce several
      // flows at once (root + descendants, saved descendants-first).
      const bundleCount = result.flows.length;
      const subflowNote = bundleCount > 1 ? ` (plus ${bundleCount - 1} nested subflow flow(s))` : '';
      const summary = {
        flowId: result.flow.id,
        flowName: result.flow.name,
        nodeCount: result.flow.nodes.length,
        edgeCount: result.flow.edges.length,
        ...(bundleCount > 1 ? { flows: result.flows.map((f) => ({ id: f.id, name: f.name })) } : {}),
        validation: result.validation,
        ...(toolName === 'create_flow'
          ? {
              saved: result.saved,
              ...(result.saved
                ? { note: `Flow "${result.flow.name}"${subflowNote} was created. It is callable as a tool on this MCP server (after a fresh tools/list) and as model "flow-${result.flow.name}" on the OpenAI-compatible endpoint.` }
                : { note: 'NOT saved: validation found errors. Fix the issues and call create_flow again.' }),
            }
          : {}),
      };
      // create_flow that could not save is an error outcome for the caller's loop.
      return textResult(summary, toolName === 'create_flow' && !result.saved);
    }

    return textResult({ error: `Unknown authoring tool: ${toolName}` }, true);
  } catch (err) {
    log.error('authoringCallTool failed', { toolName, err });
    return textResult(
      { error: `Authoring tool failed: ${err instanceof Error ? err.message : String(err)}` },
      true
    );
  }
}
