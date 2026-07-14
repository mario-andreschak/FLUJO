/**
 * Quick-Chats (issue #61): synthesize an ephemeral in-memory Flow from a set of
 * SELECTIONS (one model + zero or more MCP servers / tool subsets), so a user
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

export interface QuickChatServerSelection {
  /** MCP server name as configured in FLUJO. */
  name: string;
  /** Tool names to enable; omitted → every tool the server exposes. */
  enabledTools?: string[];
}

export interface QuickChatSelection {
  /** The conversation this quick chat belongs to (namespaces the flow id). */
  conversationId: string;
  /** Model id (preferred) — also resolvable by displayName/name. */
  modelId: string;
  /** MCP servers / tool subsets to make available to the chat. */
  servers?: QuickChatServerSelection[];
  /** Optional system-level prompt (lands on the Start node). */
  systemPrompt?: string;
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
  }
): QuickChatSynthesisResult {
  if (!selection?.conversationId) {
    return { flow: null, error: 'A conversationId is required.' };
  }
  if (!selection.modelId || typeof selection.modelId !== 'string') {
    return { flow: null, error: 'A model is required for a quick chat.' };
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

  const spec: FlowSpec = {
    name: 'Quick Chat',
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
        ...(serverRefs.length > 0 ? { servers: serverRefs } : {}),
      },
      { key: 'finish', type: 'finish', label: 'Finish' },
    ],
    edges: [
      { from: 'start', to: 'chat' },
      { from: 'chat', to: 'finish' },
    ],
  };

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

  // Namespace the id so the engine's compiled-flow cache can't collide with a
  // stored flow, and give it a stable, readable name.
  compiled.flow.id = quickChatFlowId(selection.conversationId);
  compiled.flow.name = 'Quick Chat';
  return { flow: compiled.flow };
}
