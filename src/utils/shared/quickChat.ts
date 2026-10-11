/**
 * Quick-Chats (issue #61): synthesize an ephemeral in-memory Flow from a set of
 * SELECTIONS (one model + default discovery + optional extra integrations), so a user
 * can chat with a model and its tools without building and saving a flow.
 *
 * The synthesized flow travels WITH the conversation state (`flowSnapshot`, see
 * runFlow / PocketflowEngine) and never enters the flows store — so nothing that
 * lists flows (dashboard, subflow pickers, scheduler, /v1/models) has to filter
 * a "temporary" flag, and follow-up turns / restarts work by construction.
 *
 * Security boundary: this function takes SELECTIONS and builds the graph itself.
 * It never accepts a caller-supplied node graph or arbitrary node properties.
 * Unknown model/server ids are rejected; requested tools are intersected with
 * the tools the server actually exposes. The heavy lifting of producing valid
 * ReactFlow JSON (handle ids, edge ids, MCP nodes + edges) is delegated to the
 * tested {@link compileFlowSpec}, so the quick-chat graph is shaped exactly like
 * a hand-built or generated one.
 *
 * Pure data-in/data-out (no services) so it is safe on backend and browser and
 * unit-testable; the API route gathers the model/server/tool context from the
 * services and passes it in.
 */
import { Flow } from '@/shared/types/flow';
import {
  FlowSpec,
  FlowSpecServerRef,
  compileFlowSpec,
  CompileContext,
} from './flowSpecCompiler';

/** Small bootstrap catalog; downstream tool schemas are discovered on demand. */
export const QUICK_CHAT_DISCOVERY_TOOLS = [
  'discover_capabilities',
  'list_mcp_servers',
  'list_mcp_server_tools',
  'call_mcp_tool',
  'list_flows',
  'explain_flow',
  'read_flow',
  'execute_flow',
] as const;

const DISCOVERY_PROMPT = `Use FLUJO's configured tools and saved flows when they help fulfill the user's request.
Start with discover_capabilities for a goal, or list_mcp_servers / list_flows to browse.
Inspect a tool's input schema with list_mcp_server_tools before calling call_mcp_tool with the exact server, tool, and arguments.
Use explain_flow or read_flow to understand a flow before execute_flow. Follow pagination when more results are needed.
Discover capabilities when needed; ordinary conversation does not require a tool call.
Never invent tool or flow names, claim execution without its result, or treat discovery as execution approval.`;

export interface QuickChatServerSelection {
  /** MCP server name as configured in FLUJO. */
  name: string;
  /** Tool names to enable; omitted → every tool the server exposes. */
  enabledTools?: string[];
}

export interface QuickChatSelection {
  /** The conversation this quick chat belongs to (namespaces an ephemeral flow id). */
  conversationId?: string;
  /** Model id (preferred) — also resolvable by displayName/name. */
  modelId: string;
  /** MCP servers / tool subsets to make available to the chat. */
  servers?: QuickChatServerSelection[];
  /** Optional system-level prompt (lands on the Start node). */
  systemPrompt?: string;
  /** Optional named run artifact, exposed through the existing write_resource tool. */
  runArtifactName?: string;
}

export interface QuickChatFlowIdentity {
  /** A normal persisted-flow UUID (never a quickchat-* snapshot id). */
  flowId: string;
  /** User-facing saved flow name. */
  flowName: string;
}

export interface QuickChatSynthesisResult {
  /** The synthesized flow, or null when a selection was invalid. */
  flow: Flow | null;
  /** Human-readable reason when `flow` is null. */
  error?: string;
}

/**
 * Namespaced id for a quick chat's snapshot flow. `quickchat-<conversationId>`
 * can never collide with a stored flow id, so the engine's compiled-flow cache
 * (keyed by flow id) is safe.
 */
export function quickChatFlowId(conversationId: string): string {
  return `quickchat-${conversationId}`;
}

/** True when a flow id belongs to a Quick-Chat snapshot (never a stored flow). */
export function isQuickChatFlowId(flowId: string | null | undefined): boolean {
  return typeof flowId === 'string' && flowId.startsWith('quickchat-');
}

/** Resolve a model reference the same way the compiler does: id, then displayName, then name. */
function resolveModelId(
  ref: string,
  models: NonNullable<CompileContext['models']>
): string | null {
  if (models.some((m) => m.id === ref)) return ref;
  const lower = ref.toLowerCase();
  const byDisplay = models.find((m) => m.displayName?.toLowerCase() === lower);
  if (byDisplay) return byDisplay.id;
  const byName = models.find((m) => m.name?.toLowerCase() === lower);
  return byName ? byName.id : null;
}

/**
 * Synthesize an ephemeral quick-chat flow from validated selections.
 *
 * Returns `{ flow: null, error }` when the model is missing/unknown, a selected
 * server is not configured, or the compiler could not produce a usable flow.
 */
export function synthesizeQuickChatFlow(
  selection: QuickChatSelection,
  context: {
    models: NonNullable<CompileContext['models']>;
    servers: Array<{ name: string }>;
    serverTools?: Record<string, string[]>;
    /** Backend-resolved bundled FLUJO connection; never a caller-selected identity. */
    discoveryServer?: string;
  },
  identity?: QuickChatFlowIdentity
): QuickChatSynthesisResult {
  if (!identity && !selection?.conversationId) {
    return { flow: null, error: 'A conversationId is required.' };
  }
  if (identity && (!identity.flowId || !identity.flowName)) {
    return { flow: null, error: 'A flow id and name are required.' };
  }
  if (!selection.modelId || typeof selection.modelId !== 'string') {
    return { flow: null, error: 'A model is required for a quick chat.' };
  }
  if (selection.runArtifactName !== undefined && (typeof selection.runArtifactName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(selection.runArtifactName))) {
    return { flow: null, error: 'Use a bounded run artifact name.' };
  }

  const resolvedModelId = resolveModelId(selection.modelId, context.models);
  if (!resolvedModelId) {
    return { flow: null, error: `Unknown model "${selection.modelId}".` };
  }

  const knownServers = new Set(context.servers.map((s) => s.name));
  const serverTools = context.serverTools ?? {};
  const serverRefs: FlowSpecServerRef[] = [];
  const seen = new Set<string>();
  for (const sel of selection.servers ?? []) {
    const name = sel?.name;
    if (!name || typeof name !== 'string') {
      return { flow: null, error: 'A selected server is missing its name.' };
    }
    if (!knownServers.has(name)) {
      return { flow: null, error: `Unknown MCP server "${name}".` };
    }
    if (seen.has(name)) continue; // ignore duplicate selections of the same server
    seen.add(name);

    const known = serverTools[name];
    let tools: string[] | undefined;
    if (Array.isArray(sel.enabledTools)) {
      const requested = sel.enabledTools.filter((t) => typeof t === 'string' && t);
      // Intersect with what the server actually exposes (when we know it): a
      // caller can never enable a tool the server doesn't have.
      tools = known ? requested.filter((t) => known.includes(t)) : requested;
    } else {
      // Whole-server selection → every tool we know about.
      tools = known ? [...known] : undefined;
    }
    serverRefs.push({ name, ...(tools ? { tools } : {}) });
  }

  // Saved-model conversion shares this builder but keeps its authored selection.
  const discoveryServer = identity ? undefined : context.discoveryServer;
  if (discoveryServer) {
    if (!knownServers.has(discoveryServer)) {
      return { flow: null, error: 'The FLUJO discovery connection is unavailable.' };
    }
    const existing = serverRefs.find((server) => server.name === discoveryServer);
    if (existing) {
      existing.tools = [...new Set([...(existing.tools ?? serverTools[discoveryServer] ?? []), ...QUICK_CHAT_DISCOVERY_TOOLS])];
    } else {
      serverRefs.push({ name: discoveryServer, tools: [...QUICK_CHAT_DISCOVERY_TOOLS] });
    }
  }

  const spec: FlowSpec = {
    name: identity?.flowName ?? 'Quick Chat',
    nodes: [
      {
        key: 'start',
        type: 'start',
        label: 'Start',
        ...(selection.systemPrompt ? { prompt: selection.systemPrompt } : {}),
      },
      {
        key: 'chat',
        type: 'process',
        label: 'Chat',
        model: resolvedModelId,
        ...(discoveryServer ? { prompt: DISCOVERY_PROMPT } : {}),
        ...(serverRefs.length > 0 ? { servers: serverRefs } : {}),
      },
      { key: 'finish', type: 'finish', label: 'Finish' },
    ],
    edges: [
      { from: 'start', to: 'chat' },
      { from: 'chat', to: 'finish' },
    ],
  };

  if (selection.runArtifactName) {
    spec.nodes.push({ key: 'artifact', type: 'resource', label: selection.runArtifactName, runName: selection.runArtifactName });
    spec.edges.push({ from: 'chat', to: 'artifact' });
  }
  const compiled = compileFlowSpec(spec, {
    models: context.models,
    servers: context.servers,
    serverTools,
  });

  if (!compiled.flow) {
    const reason = compiled.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.message)
      .join(' ');
    return { flow: null, error: reason || 'Could not synthesize a quick-chat flow.' };
  }

  // Quick Chat keeps its namespaced snapshot identity. Saved-agent callers
  // supply a normal UUID + user-facing name while reusing the exact same graph
  // construction and model/MCP validation path.
  compiled.flow.id = identity?.flowId ?? quickChatFlowId(selection.conversationId!);
  compiled.flow.name = identity?.flowName ?? 'Quick Chat';
  return { flow: compiled.flow };
}
