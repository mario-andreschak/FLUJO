// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { ToolHandler } from '../handlers/ToolHandler';
import { ModelHandler } from '../handlers/ModelHandler';
import { ResourceHandler } from '../handlers/ResourceHandler';
import { buildRunResourceTools, buildReadResourceTool, READ_RESOURCE_TOOL_NAME } from '../handlers/runResourceTools';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import { buildNodeContext, scopeMessagesForInput, collapseNodeOutputs, deriveModelInputView } from '../buildNodeContext';
import { buildHandoffDescription } from '../buildHandoffDescription';
import { buildHandoffToolNameMap } from '@/shared/utils/handoffNaming';
import { flowService } from '@/backend/services/flow/index';
import { FlowNode } from '@/shared/types/flow';
import { FEATURES } from '@/config/features'; // Import feature flags
import {
  SharedState,
  ProcessNodeParams,
  ProcessNodePrepResult,
  ProcessNodeExecResult,
  ToolDefinition,
  HandoffToolInfo,
  STAY_ON_NODE_ACTION, // Keep for reference, but won't be returned directly by post
  TOOL_CALL_ACTION,    // Import new actions
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
  ToolCallInfo
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Import FlujoChatMessage
import { evaluateCondition, selectConditionText } from '@/utils/shared/edgeConditions';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { resolveKvNodeRefs, captureKvValue, type KvFlowContext } from '../resolveKvNodeRefs';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/ProcessNode');

export class ProcessNode extends BaseNode {
  /**
   * Generate handoff tools for each connected non-MCP node
   */
  private async generateHandoffTools(sharedState: SharedState): Promise<ToolDefinition[]> {
    log.info('Generating handoff tools');

    // Get all actions (edge IDs)
    const allActions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});

    // Filter out MCP edges - only keep standard edges for flow navigation
    const actions = allActions.filter(action =>
      !action.includes('-mcpEdge') &&
      !action.endsWith('mcpEdge') &&
      !action.includes('-mcp')
    );

    log.debug('Found standard actions for handoff tools', {
      actionsCount: actions.length,
      actions
    });

    // Collect the UNIQUE handoff targets (id/label/type). Two routes to the same
    // node — e.g. a legacy forward edge plus a bidirectional back-edge — must
    // yield a single tool (providers reject duplicate tool names, and either
    // route hands off to the same target anyway).
    const targets: { id: string; label: string; type: string }[] = [];
    const seenIds = new Set<string>();
    for (const edgeId of actions) {
      const targetNode = this.successors instanceof Map
        ? this.successors.get(edgeId)
        : (this.successors as any)[edgeId];
      if (!targetNode) {
        log.warn(`Target node not found for edge ${edgeId}`);
        continue;
      }
      const id = targetNode.node_params?.id || 'unknown';
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      targets.push({
        id,
        label: targetNode.node_params?.label || 'Unknown Node',
        type: targetNode.node_params?.type || 'unknown',
      });
    }

    // Human-readable, collision-free tool names (issue #38, Item A): the raw
    // node UUID is gone from the name; SharedState.handoffNameMap keeps the
    // name -> node-id mapping so routing still works.
    const nameMap = buildHandoffToolNameMap(targets);
    sharedState.handoffNameMap = sharedState.handoffNameMap || {};

    // Load the containing flow once so descriptions can read each target's
    // user-authored description and full properties (and recurse into subflows).
    let flowNodesById: Map<string, FlowNode> | null = null;
    try {
      const flow = await flowService.getFlow(sharedState.flowId);
      if (flow) {
        flowNodesById = new Map(flow.nodes.map(n => [n.id, n]));
      }
    } catch (err) {
      log.warn('Could not load flow for handoff descriptions; using basic descriptions', { err });
    }

    const handoffTools: ToolDefinition[] = [];
    for (const target of targets) {
      const toolName = nameMap.get(target.id) || `handoff_to_${target.id}`;
      sharedState.handoffNameMap[toolName] = target.id;

      const flowNode = flowNodesById?.get(target.id);
      const description = flowNode
        ? await buildHandoffDescription(flowNode)
        : `Hand off execution to ${target.label} (${target.type})`;

      // A subflow node in 'isolated' inputMode that opted into `allowCallerPrompt`
      // (issue #96) lets the routing model pass an instruction to the child flow.
      // Only those targets get a `prompt` parameter; every other handoff tool
      // stays byte-identically parameter-less (preserving the provider
      // prefix-cache stability from #89). The param is OPTIONAL: the model may
      // still route with no prompt, in which case the authored promptTemplate is
      // used as the default (see SubflowNode.prep).
      const targetProps = flowNode?.data?.properties as { inputMode?: string; allowCallerPrompt?: boolean; allowCallerFanout?: boolean; promptTemplate?: string } | undefined;
      // Spawn-with-brief (issue #156, supersedes the #130 `parallelFlows` param):
      // a subflow target that opted into `allowCallerFanout` is a SPAWNABLE
      // sub-agent. Its handoff tool gains an optional `task` string, and the
      // description tells the model it may call the tool several times in ONE
      // turn — each call spawns one parallel, independently-briefed instance of
      // the target. runFlow captures every matching call's brief single-shot;
      // SubflowNode.prep turns them into parallel lanes. Every OTHER handoff
      // tool keeps the byte-identical empty schema (preserving the #89 provider
      // prefix-cache stability).
      const acceptsCallerSpawn =
        target.type === 'subflow' && targetProps?.allowCallerFanout === true;
      const acceptsCallerPrompt =
        target.type === 'subflow' &&
        targetProps?.inputMode === 'isolated' &&
        targetProps?.allowCallerPrompt === true;
      // Issue #169: for a NON-spawn, isolated, allowCallerPrompt subflow that has
      // NO authored message on the node itself (empty promptTemplate), the caller
      // MUST supply a prompt — otherwise the subflow starts with an empty prompt
      // and the chain dies silently (StartNode asks the user for input). In that
      // exact configuration we mark `prompt` as JSON-Schema `required`, turning a
      // silent runtime dead-end into a schema-enforced guarantee. Every other
      // configuration keeps `prompt` optional exactly as before.
      const promptIsMandatory =
        acceptsCallerPrompt &&
        targetProps?.allowCallerFanout !== true &&
        !(targetProps?.promptTemplate?.trim());

      const paramProps: Record<string, unknown> = {};
      const requiredParams: string[] = [];
      const descExtras: string[] = [];
      if (acceptsCallerSpawn) {
        // `task` subsumes `prompt` for spawnable targets (a single spawn with a
        // brief behaves like a caller prompt), so only one param is exposed.
        paramProps.task = {
          type: "string",
          description: "The brief for this spawned instance of the sub-agent: what this one copy should work on. Optional; omit it (and call the tool once) for a plain handoff."
        };
        descExtras.push(
          'PARALLEL SPAWNING: You may call this tool MULTIPLE TIMES in the SAME response — each call spawns one parallel instance of this sub-agent, briefed with that call\'s "task". All instances run concurrently in the background; their results are merged in call order and the flow continues once every instance has finished. To split work, make one call per sub-task, each with a specific, self-contained "task".'
        );
      } else if (acceptsCallerPrompt) {
        paramProps.prompt = {
          type: "string",
          description: promptIsMandatory
            ? "REQUIRED initial brief/instruction for the target subflow (isolated mode). The subflow has no authored message of its own, so you MUST supply what it should work on — omitting it makes the subflow start with an empty prompt and stall."
            : "Instruction/prompt to run the target subflow with (isolated mode). Optional; omitted falls back to the subflow's default prompt."
        };
        if (promptIsMandatory) {
          requiredParams.push('prompt');
          descExtras.push('You MUST pass a "prompt" argument instructing the target subflow — it has no authored message of its own.');
        } else {
          descExtras.push('Optionally pass a "prompt" argument to instruct the target subflow; omit it to use its default prompt.');
        }
      }
      const hasParams = Object.keys(paramProps).length > 0;

      handoffTools.push({
        name: toolName,
        description: descExtras.length > 0 ? `${description}\n\n${descExtras.join('\n\n')}` : description,
        inputSchema: {
          type: "object",
          properties: hasParams ? paramProps : {}, // parameter-less for a standard handoff
          required: requiredParams
        }
      });

      log.debug(`Created handoff tool`, { toolName, targetNodeId: target.id, targetNodeLabel: target.label });
    }

    log.info('Generated handoff tools', {
      toolsCount: handoffTools.length
    });

    return handoffTools;
  }

  async prep(sharedState: SharedState, node_params?: ProcessNodeParams): Promise<ProcessNodePrepResult> {
    log.info('prep() started');

    // Extract properties from node_params
    const nodeId = node_params?.id;
    const flowId = sharedState.flowId;
    const boundModel = node_params?.properties?.boundModel;
    const excludeModelPrompt = node_params?.properties?.excludeModelPrompt || false;
    const excludeStartNodePrompt = node_params?.properties?.excludeStartNodePrompt || false;
    const excludeSystemPrompt = node_params?.properties?.excludeSystemPrompt || false;

    log.debug('Extracted properties', {
      nodeId,
      flowId,
      boundModel,
      excludeModelPrompt,
      excludeStartNodePrompt,
      excludeSystemPrompt
    });

    if (!nodeId || !flowId) {
      log.error('Missing required node or flow ID', { nodeId, flowId });
      throw new Error("Process node requires node ID and flow ID");
    }

    if (!boundModel) {
      log.error('Missing bound model');
      throw new Error("Process node requires a bound model");
    }

    // Use the promptRenderer to build the complete prompt
    log.info('Using promptRenderer to build the complete prompt');
    const renderedPrompt = await promptRenderer.renderPrompt(flowId, nodeId, {
      renderMode: 'rendered',
      includeConversationHistory: false,
      excludeModelPrompt,
      excludeStartNodePrompt,
      excludeSystemPrompt,
      // Tier 3: announce each resource pill the renderer resolves as a live
      // resource:read event, attributed to this node. The renderer itself
      // stays state-agnostic — it just calls back.
      onResourceRead: (info) => sharedState.emit?.({
        type: 'resource:read',
        node: { nodeId },
        source: 'pill',
        ...info,
      }),
    });

    // Tier 2c (named variables): inject `${var:NAME}` from the run-scoped
    // scratchpad AFTER rendering. PromptRenderer is state-agnostic by design
    // (it has no SharedState), so the substitution happens here where the vars
    // are in scope. This is plaintext map lookup — NOT resolveGlobalVars (which
    // decrypts `${global:VAR}` for tool args / API keys and never touches prompts).
    // Tier 3: then inject `${res:NAME}` named run resources (after vars, no
    // recursion — see resolveRunResourceRefs).
    let completePrompt = await resolveRunResourceRefs(
      resolveRunVars(renderedPrompt, sharedState.variables),
      sharedState.ephemeral ? undefined : sharedState.conversationId,
      sharedState.emit,
      { nodeId }
    );

    // Tier 4 (persistent kv): inject `${kv:NAME}` cross-run values AFTER vars
    // and resources. Scope needs the flow's folder, fetched once (lazily) and
    // reused for the isolatedPrompt below. Plaintext, crypto-free — NOT secrets
    // (never resolveGlobalVars), and persistent unlike `${var:}` / `${res:}`.
    let kvCtx: KvFlowContext | null = null;
    const kvContext = async (): Promise<KvFlowContext> => {
      if (kvCtx) return kvCtx;
      let folder: string | undefined;
      try { folder = (await flowService.getFlow(flowId))?.folder; } catch { /* best effort */ }
      kvCtx = { flowId, folder };
      return kvCtx;
    };
    if (completePrompt.includes('${kv:')) {
      completePrompt = await resolveKvNodeRefs(completePrompt, await kvContext());
    }

    // Tier 3: resource NODES wired to this step (consume role) inject their
    // contents as a "## Resources" block — the graph-visible sibling of
    // resource pills. Reads never break the run (failures render as notes).
    const resourceNodes = node_params?.properties?.resourceNodes || [];
    if (resourceNodes.length > 0) {
      const resourceBlock = await ResourceHandler.processResourceNodes({
        resourceNodes,
        conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
        emit: sharedState.emit,
      });
      completePrompt += resourceBlock;
    }

    log.debug('Prompt rendered successfully', {
      completePromptLength: completePrompt.length,
      completePromptPreview: completePrompt.length > 100 ?
        completePrompt.substring(0, 100) + '...' : completePrompt
    });

    // Set the current node ID in shared state
    sharedState.currentNodeId = nodeId;

    // Check if tools are already available in shared state
    let availableTools: ToolDefinition[] = [];

    if (sharedState.mcpContext && sharedState.mcpContext.availableTools && sharedState.mcpContext.availableTools.length > 0) {
      // Use tools already processed by MCPNode
      log.info('Using MCP tools from shared state', {
        toolsCount: sharedState.mcpContext.availableTools.length
      });
      availableTools = sharedState.mcpContext.availableTools;
    } else {
      // Only process MCP nodes if tools are not available in shared state
      const mcpNodes = node_params?.properties?.mcpNodes || [];

      if (mcpNodes.length > 0) {
        log.info('No MCP tools found in shared state, processing MCP nodes', {
          mcpNodesCount: mcpNodes.length
        });

        // Process MCP nodes using the ToolHandler
        const mcpResult = await ToolHandler.processMCPNodes({ mcpNodes });

        if (!mcpResult.success) {
          log.error('Failed to process MCP nodes', { error: mcpResult.error });
          throw new Error(`Failed to process MCP nodes: ${mcpResult.error.message}`);
        }

        availableTools = mcpResult.value.availableTools;
      }
    }

    // Generate handoff tools for each connected non-MCP node
    const handoffTools = await this.generateHandoffTools(sharedState);

    // Add handoff tools to available tools
    availableTools = [...availableTools, ...handoffTools];

    // Tier 3 (issue #161): when a PRODUCE-role run-artifact resource node is
    // wired to this step, offer an explicit `write_resource` tool so the model
    // can write the artifact's real content — replacing the old passive capture
    // of the node's final text (which was empty when the step handed off). Only
    // added when such a node is wired, so resource-free steps keep byte-identical
    // tools (preserving #89 prefix-cache stability). Dispatch is handled by name
    // in ModelHandler (OpenAI path) / localToolExecutors (subscription path).
    const runResourceTools = buildRunResourceTools(node_params?.properties?.resourceNodes);
    if (runResourceTools.length > 0) {
      availableTools = [...availableTools, ...runResourceTools];
    }

    // Record the model-facing-name -> (server, tool) mapping for MCP tools so the
    // model's tool calls can be decoded later, including across a tool-approval
    // resume (#16). Handoff tools have no server and are decoded by name prefix.
    sharedState.toolNameMap = sharedState.toolNameMap || {};
    for (const tool of availableTools) {
      if (tool.server && tool.originalName) {
        sharedState.toolNameMap[tool.name] = { server: tool.server, tool: tool.originalName, timeout: tool.timeout };
      }
    }

  // Create a properly typed PrepResult
  const prepResult: ProcessNodePrepResult = {
    nodeId,
    nodeType: 'process',
    currentPrompt: completePrompt,
    boundModel,
    availableTools: availableTools,
    messages: [], // Will be populated after reordering
    // Forwarded so self-orchestrating adapters can surface mid-run tool-approval
    // prompts on this conversation's event stream and honour the approval setting.
    conversationId: sharedState.conversationId,
    requireToolApproval: sharedState.requireApproval ?? false,
  };

    // Create our own system message with the current prompt as FlujoChatMessage
    const systemMessage: FlujoChatMessage = {
      id: uuidv4(), // Generate unique ID
      role: 'system',
      content: completePrompt,
      timestamp: Date.now() // Add timestamp
    };

    log.info('Added system message from prompt template', {
      contentLength: completePrompt.length,
      contentPreview: completePrompt.length > 100 ?
        completePrompt.substring(0, 100) + '...' : completePrompt
    });

    // Assemble the node's threaded history (lossless — this is written back to
    // SharedState.messages). Stripping handoff plumbing for the MODEL happens at
    // the provider boundary (ModelHandler.generateCompletion → stripHandoffPlumbing),
    // so persisted history is never destroyed. See ~/.claude/plans/execution-core-v2.md.
    prepResult.messages = buildNodeContext(sharedState.messages, systemMessage);

    // Shape what the MODEL sees — both wire-only, prepResult.messages stays the
    // full history so post() writes it back intact and the tool loop can
    // re-enter without losing the prior conversation:
    //  1. collapseNodeOutputs: drop the settled tool exchanges of every node
    //     whose outputMode is 'latest-message' (their final responses survive).
    //  2. scopeMessagesForInput: narrow to this node's inputMode
    //     (latest-message / isolated).
    // When neither applies, wireMessages stays unset and the model sees
    // prepResult.messages verbatim.
    const inputMode = node_params?.properties?.inputMode ?? 'full-history';
    let wireBase = prepResult.messages;
    try {
      const flow = await flowService.getFlow(flowId);
      const collapsedNodeIds = new Set(
        (flow?.nodes ?? [])
          .filter((n) => n.type === 'process' && n.data?.properties?.outputMode === 'latest-message')
          .map((n) => n.id)
      );
      wireBase = collapseNodeOutputs(prepResult.messages, collapsedNodeIds);
    } catch (err) {
      // Collapsing is a context-token optimization — never block the run on it.
      log.warn('Could not resolve outputMode collapse set; sending the full wire view', { err });
    }
    if (inputMode !== 'full-history' || wireBase !== prepResult.messages) {
      // Tier 2c: resolve `${var:NAME}` in the isolated prompt too (wire-only text,
      // like the system prompt) so an isolated step can pull captured state.
      // Tier 3: `${res:NAME}` likewise.
      const isolatedPrompt = node_params?.properties?.isolatedPrompt;
      let resolvedIsolatedPrompt = isolatedPrompt !== undefined
        ? await resolveRunResourceRefs(
            resolveRunVars(isolatedPrompt, sharedState.variables),
            sharedState.ephemeral ? undefined : sharedState.conversationId,
            sharedState.emit,
            { nodeId }
          )
        : isolatedPrompt;
      // Tier 4: `${kv:NAME}` in the isolated prompt too (wire-only text).
      if (typeof resolvedIsolatedPrompt === 'string' && resolvedIsolatedPrompt.includes('${kv:')) {
        resolvedIsolatedPrompt = await resolveKvNodeRefs(resolvedIsolatedPrompt, await kvContext());
      }
      prepResult.wireMessages = scopeMessagesForInput(
        wireBase,
        inputMode,
        resolvedIsolatedPrompt,
      );
    }

    // Issue #168: auto-expose the `read_resource` tool when the wire history
    // actually references a run resource (a `flujo://run/...` marker left by an
    // oversized captured tool result/args), so the model can dereference it back
    // to full content — even when the flujo MCP server isn't attached. Gated on
    // the marker being present so resource-free flows keep a byte-identical tool
    // set (preserving the #89 provider prefix-cache stability). Scanned over the
    // SCOPED wire view the model actually receives; the node's own live loop has
    // produced nothing yet at prep time, so only PRIOR history is inspected.
    const wireForScan = prepResult.wireMessages ?? wireBase;
    const historyHasRunResourceUri = wireForScan.some(
      (m) => JSON.stringify(m).includes(RUN_RESOURCE_SCHEME),
    );
    if (
      historyHasRunResourceUri &&
      !availableTools.some((t) => t.name === READ_RESOURCE_TOOL_NAME)
    ) {
      // prepResult.availableTools is the same array reference, so this is picked
      // up by execCore's toolNameMap build and the model call.
      availableTools.push(buildReadResourceTool());
    }

    log.info('Assembled node context', {
      systemMessageCount: 1,
      totalMessageCount: prepResult.messages.length,
      inputMode,
      wireMessageCount: prepResult.wireMessages?.length,
    });

    // Debugger model-input visualization (issue #153): explain how this exact
    // conversation reaches the model — the resolved system message, the wire
    // conversation the model receives (after fold + scope + handoff-plumbing
    // strip), and per-message provenance. Derived from the SAME pipeline
    // functions used above, so it can never drift from behaviour. Gated on debug
    // mode / the execution tracker so normal runs pay nothing, and carries
    // conversation content ONLY (never credentials).
    if (sharedState.debugMode || FEATURES.ENABLE_EXECUTION_TRACKER) {
      try {
        prepResult.modelInput = deriveModelInputView({
          threaded: prepResult.messages,
          foldedView: wireBase,
          scopedView: prepResult.wireMessages ?? wireBase,
          systemContent: completePrompt,
          inputMode,
        });
        // Issue #167 (Phase 2 of #162): expose the per-model-call wire snapshots
        // this visit produced as an ordered array the debugger can page through,
        // keeping `modelInput` as the first/representative entry for backward
        // compatibility. A Process node makes exactly ONE model call per visit:
        // the FLUJO-driven tool loop re-runs the whole node each iteration (each
        // becomes its own DebugStep with its own snapshot), and a self-
        // orchestrating adapter (Claude subscription) runs its additional turns
        // internally where FLUJO cannot recompute the wire — so the outer wire is
        // the faithful representative and the array has a single entry today. The
        // plural shape lets the frontend page uniformly and is ready for any
        // future in-node multi-call loop.
        prepResult.modelInputs = [prepResult.modelInput];
      } catch (err) {
        // Observability must never break a run.
        log.warn('Could not derive model-input debug view', { err });
      }
    }

    log.info('prep() completed', {
      completePromptLength: completePrompt.length,
      boundModel,
      hasTools: !!prepResult.availableTools?.length,
      toolsCount: prepResult.availableTools?.length || 0,
      messagesCount: prepResult.messages.length
    });

    return prepResult;
  }

  async execCore(prepResult: ProcessNodePrepResult, node_params?: ProcessNodeParams): Promise<ProcessNodeExecResult> {
    log.info('execCore() started', {
      boundModel: prepResult.boundModel,
      promptLength: prepResult.currentPrompt?.length,
      messagesCount: prepResult.messages?.length || 0
    });

    // Add verbose logging of the entire prepResult
    log.debug('execCore() prepResult', prepResult);

    try {
      // Prepare tools if available
      let tools: OpenAI.ChatCompletionTool[] | undefined = undefined; // Initialize tools

      if (prepResult.availableTools && prepResult.availableTools.length > 0) {
        const toolsResult = ToolHandler.prepareTools({
          availableTools: prepResult.availableTools
        });

        if (!toolsResult.success) {
          log.error('Failed to prepare tools', { error: toolsResult.error });
          throw new Error(`Failed to prepare tools: ${toolsResult.error.message}`);
        }

        tools = toolsResult.value.tools;
      }

      // Rebuild the model-facing-name -> (server, tool) map from the bound tools
      // (mirrors prep()'s SharedState.toolNameMap) so adapters that run their own
      // agentic tool loop (Claude subscription) can dispatch calls to mcpService.
      const toolNameMap: Record<string, { server: string; tool: string; timeout?: number }> = {};
      for (const t of prepResult.availableTools ?? []) {
        if (t.server && t.originalName) {
          toolNameMap[t.name] = { server: t.server, tool: t.originalName, timeout: t.timeout };
        }
      }

      // Get the node name for display
      const nodeName = node_params?.label || node_params?.properties?.name || 'Process Node';

      // --- Log before calling the model ---
      const lastMessage = prepResult.messages && prepResult.messages.length > 0 ? prepResult.messages[prepResult.messages.length - 1] : null;
      log.debug(`[ProcessNode ${prepResult.nodeId}] Calling ModelHandler.callModel`, {
        modelId: prepResult.boundModel,
        messageCount: prepResult.messages?.length || 0,
        toolCount: tools?.length || 0,
        lastMessageType: lastMessage?.role,
        lastMessageToolCallId: lastMessage?.role === 'tool' ? lastMessage.tool_call_id : undefined,
        lastMessageContentPreview: typeof lastMessage?.content === 'string' ? lastMessage.content.substring(0, 100) + '...' : '(non-string content)'
      });

      let modelResult;
      try {
        // Call the model with tool support
        modelResult = await ModelHandler.callModel({
          modelId: prepResult.boundModel,
          prompt: prepResult.currentPrompt,
        messages: prepResult.messages,
        // Scoped view for latest-message / isolated inputMode; when unset the
        // model sees `messages` verbatim (full-history). Persistence always uses
        // the full `messages`, never this.
        wireMessages: prepResult.wireMessages,
        tools,
        iteration: 1, // Iteration is no longer handled by ModelHandler, but keep for now
        maxIterations: 1, // Vestigial: the agentic-turn cap is now resolved from maxTurns (see below)
        // Per-node override of the agentic-turn cap. ModelHandler merges this with
        // the bound model's maxTurns setting and the system default (50), replacing
        // the former hard-coded 30 that aborted long Claude-subscription runs (#48).
        maxTurns: node_params?.properties?.maxTurns,
        // Per-node override of the per-completion output-token cap (#189).
        // ModelHandler resolves this against the bound model's maxTokens, then
        // lets the adapter apply its own default when both are unset.
        maxTokens: node_params?.properties?.maxTokens,
          nodeName, // Pass the node name to be included in the response header
          nodeId: prepResult.nodeId, // Pass the node ID
          toolNameMap, // Lets self-orchestrating adapters dispatch tool calls to mcpService
          conversationId: prepResult.conversationId, // For mid-run tool-approval prompts
          requireToolApproval: prepResult.requireToolApproval // Gate tool calls on user approval
        });

        // --- Log successful model call result (check success first) ---
        if (modelResult.success) {
          log.debug(`[ProcessNode ${prepResult.nodeId}] ModelHandler.callModel returned successfully`, {
            success: true, // Already checked
            hasContent: !!modelResult.value?.content,
            contentLength: modelResult.value?.content?.length || 0,
            toolCallsCount: modelResult.value?.toolCalls?.length || 0
          });
        } else {
           // Log failure if somehow success check failed here (should be caught later)
           log.warn(`[ProcessNode ${prepResult.nodeId}] ModelHandler.callModel returned failure state unexpectedly here`, { success: false, error: modelResult.error });
        }


      } catch (modelCallError) {
        // --- Log error during model call ---
        log.error(`[ProcessNode ${prepResult.nodeId}] Error calling ModelHandler.callModel`, { error: modelCallError });
        // Re-throw the error to be handled by the outer catch block
        throw modelCallError;
      } finally {
        // --- Log that the model call attempt finished ---
        log.debug(`[ProcessNode ${prepResult.nodeId}] Finished attempt to call ModelHandler.callModel`);
      }

      // --- Process the result (if successful) ---
      if (!modelResult || !modelResult.success) {
        // This case should ideally be caught by the try/catch, but handle defensively
        const errorDetails = modelResult?.error || { message: 'Unknown model execution error after call attempt.' };
        log.error('Model execution error after call attempt', { error: errorDetails });

        // CHANGE: Instead of returning an error result, throw a custom error
      const modelError = new Error(`Model execution failed: ${modelResult.error.message}`);

      // Add properties to the error object
      (modelError as any).isModelError = true;
      (modelError as any).details = {
        message: modelResult.error.message,
        type: modelResult.error.type,
        code: modelResult.error.code,
        // Only include modelId if it exists
        ...(modelResult.error.type === 'model' ? { modelId: modelResult.error.modelId } : {}),
        param: typeof modelResult.error.details?.param === 'string' ? modelResult.error.details.param : undefined,
        status: typeof modelResult.error.details?.status === 'number' ? modelResult.error.details.status : undefined,
        // Include all other details from the original error
        ...modelResult.error.details
      };

      // Log that we're throwing a critical error
      log.error('Throwing critical model error to abort flow execution', {
        error: modelResult.error.message,
        type: modelResult.error.type,
        code: modelResult.error.code
      });

      // Throw the error to abort execution
      throw modelError;
      }

      const result = modelResult.value;

      // Create a properly typed ExecResult
      const execResult: ProcessNodeExecResult = {
        success: true,
        content: result.content || '',
        messages: result.messages, // Messages updated during tool calls
        fullResponse: result.fullResponse,
        toolCalls: result.toolCalls
      };

      // Log tool calls if present
      if (result.toolCalls && result.toolCalls.length > 0) {
        log.info('Tool calls found in model response', {
          toolCallsCount: result.toolCalls.length,
          toolNames: result.toolCalls.map(tc => tc.name).join(', ')
        });
      }

      log.info('execCore() completed', {
        responseLength: execResult.content?.length || 0,
        messagesCount: execResult.messages?.length || 0,
        hasToolCalls: !!execResult.toolCalls?.length
      });

      // Add verbose logging of the entire execResult
      log.verbose('execCore() execResult', execResult);

      return execResult;
    } catch (error) {
    // For critical tool errors or model errors, we want to rethrow them
    // to abort the flow execution
    if (error && typeof error === 'object' &&
        ('isCriticalToolError' in error || 'isModelError' in error)) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.error('Critical error detected - propagating to abort flow:', {
        error: errorMessage,
        isModelError: 'isModelError' in error,
        isCriticalToolError: 'isCriticalToolError' in error
      });

      // Rethrow the error to stop execution and propagate to the frontend
      throw error;
      }

      // For other errors, create an error result
      const errorResult: ProcessNodeExecResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack
        } : { message: String(error) }
      };

      log.error('execCore() failed', {
        error: errorResult.error,
        errorDetails: errorResult.errorDetails
      });

      // Add verbose logging of the error result
      log.verbose('execCore() errorResult', errorResult);

      return errorResult;
    }
  }

  /**
   * Process tool calls to check for handoff requests
   */
  private processHandoffToolCalls(
    toolCalls: ToolCallInfo[] | undefined,
    sharedState: SharedState
  ): boolean {
    if (!toolCalls || toolCalls.length === 0) {
      return false;
    }

    log.info('Processing tool calls for handoff requests', {
      toolCallsCount: toolCalls.length
    });

    // Get all actions (edge IDs)
    const allActions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});

    // Filter out MCP edges - only keep standard edges for flow navigation
    const actions = allActions.filter(action =>
      !action.includes('-mcpEdge') &&
      !action.endsWith('mcpEdge') &&
      !action.includes('-mcp')
    );

    // Check for handoff tool calls
    for (const toolCall of toolCalls) {
      const { name } = toolCall; // Only need the name now

      // Check for specific handoff tools
      if (name.startsWith('handoff_to_')) {
        // Decode the target node id. Tool names no longer embed the node UUID
        // (issue #38, Item A) — resolve through handoffNameMap first, then fall
        // back to stripping the prefix for legacy `handoff_to_<uuid>` names
        // (e.g. a conversation paused for tool approval before this change).
        const targetNodeId = sharedState.handoffNameMap?.[name] || name.replace('handoff_to_', '');

        // Find the edge ID that leads to this node
        for (const edgeId of actions) {
          const targetNode = this.successors instanceof Map
            ? this.successors.get(edgeId)
            : (this.successors as any)[edgeId];

          if (targetNode && targetNode.node_params?.id === targetNodeId) {
            // Set handoff request in shared state
            sharedState.handoffRequested = {
              edgeId,
              targetNodeId
            };

            log.info(`Handoff requested to node ${targetNodeId}`, {
              edgeId,
              toolName: name
            });

            return true; // Handoff confirmed by calling the tool
          }
        } // End inner loop (edgeId)
      } // End if (name.startsWith...)
    } // End outer loop (toolCall)

    return false; // No handoff tool call found
  }

  /**
   * The node's outgoing CONTROL edge ids (routing actions) in author order,
   * for Tier 2b deterministic routing. Prefers the ordered list FlowConverter
   * recorded on node_params; falls back to the successors map (same MCP-edge
   * filter as processHandoffToolCalls) so the routing is correct even if the
   * ordered list is somehow absent. Map iteration preserves insertion order,
   * which is the edge author order.
   */
  private orderedControlEdges(node_params?: ProcessNodeParams): string[] {
    const recorded = node_params?.orderedOutgoingEdges;
    if (Array.isArray(recorded) && recorded.length > 0) return recorded;

    const allActions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    return allActions.filter(action =>
      !action.includes('-mcpEdge') &&
      !action.endsWith('mcpEdge') &&
      !action.includes('-mcp')
    );
  }

  async post(
    prepResult: ProcessNodePrepResult,
    execResult: ProcessNodeExecResult,
    sharedState: SharedState,
    node_params?: ProcessNodeParams
  ): Promise<string> {
    // --- Log start of post method ---
    log.debug(`[ProcessNode ${node_params?.id}] post() method started.`);

    log.info('post() started', {
      execResultSuccess: execResult.success,
      execResultContentLength: execResult.content?.length || 0,
      messagesCount: execResult.messages?.length || 0,
      toolCallsCount: execResult.toolCalls?.length || 0
    });

    // Store the model response or error in shared state
    if (!execResult.success) {
      // Store error information in shared state
      sharedState.lastResponse = {
        success: false,
        error: execResult.error,
        errorDetails: execResult.errorDetails
      };
      // Add tracking info (as before)
      if (Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
        // ... (tracking logic remains the same) ...
      }
      log.warn(`Execution failed for node ${node_params?.id}. Returning ERROR_ACTION.`);
      return ERROR_ACTION; // Return error action
    } else {
       // Use the content from execResult which might include prefixes
       sharedState.lastResponse = execResult.content || '';
    }

    // Tier 2c (named variables): capture this node's final output into the
    // run-scoped scratchpad so a later step can inject it via `${var:NAME}`.
    // post() mutates the shared reference once per visit, so the value is visible
    // to every later node's prep. Only on success — an errored node returns above.
    const captureVariable = node_params?.properties?.captureVariable?.trim();
    if (execResult.success && captureVariable) {
      sharedState.variables = sharedState.variables ?? {};
      sharedState.variables[captureVariable] = execResult.content ?? '';
      log.info('Captured node output into run variable', { captureVariable, nodeId: node_params?.id });
    }

    // Tier 3 (issue #161): the produce side of a run artifact is now an EXPLICIT
    // `write_resource` tool the model calls (see ProcessNode.prep +
    // handlers/runResourceTools.ts), NOT a passive capture of this node's final
    // text. The old passive `captureResource` write lived here; it was removed
    // because a step that hands off ends with empty content, so it wrote empty
    // artifacts under the wrong name (the reported "artifacts don't work" bug).

    // Tier 4 (persistent kv): also save this node's output to a PERSISTENT
    // cross-run key with `captureKv: "NAME"` (scope-prefixable as folder/flow/
    // global). Unlike captureVariable/captureResource (run-scoped), this survives
    // across runs so a scheduled pulse can carry a counter/cursor forward. Never
    // breaks the run: a cap refusal or bad name logs and moves on.
    const captureKv = node_params?.properties?.captureKv?.trim();
    if (execResult.success && captureKv) {
      try {
        let folder: string | undefined;
        try { folder = (await flowService.getFlow(sharedState.flowId))?.folder; } catch { /* best effort */ }
        const res = await captureKvValue(captureKv, execResult.content ?? '', { flowId: sharedState.flowId, folder });
        if ('skipped' in res) {
          log.warn('captureKv skipped', { captureKv, reason: res.skipped });
        } else {
          log.info('Captured node output into persistent kv', { captureKv, nodeId: node_params?.id });
        }
      } catch (error) {
        log.error('captureKv failed; continuing run', error);
      }
    }

    // Update shared state with messages from execResult — WITHOUT the node's
    // system prompt. The system message prep prepends (via buildNodeContext)
    // is the model's WIRE view, not conversation content: writing it back made
    // every persisted conversation lead with a system message, leaked it into
    // the displayed transcript, and forced special-casing in the live emitter
    // and the GET route. prep re-renders the prompt fresh every step (and
    // buildNodeContext drops any stale system messages), so nothing is lost by
    // excluding it here. (execution-core v2 Phase 3, plan §11.2.4)
    if (execResult.messages && execResult.messages.length > 0) {
      sharedState.messages = execResult.messages.filter(m => m.role !== 'system');

      log.info('Updated messages in sharedState (system prompt excluded)', {
        messagesCount: sharedState.messages.length
      });
    }

    // Add tracking information for the ProcessNode itself
    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'ProcessNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Process Node',
        modelDisplayName: prepResult.modelDisplayName || 'Unknown Model', // Note: modelDisplayName might not be in prepResult, adjust if needed
        modelTechnicalName: prepResult.boundModel || 'unknown',
        allowedTools: node_params?.properties?.allowedTools?.join(', '),
        timestamp: new Date().toISOString()
      });

      log.info('Added ProcessNode tracking information', {
        modelDisplayName: prepResult.modelDisplayName, // Adjust if needed
        modelTechnicalName: prepResult.boundModel
      });
    }

    // Process tool calls to check for handoff requests FIRST
    const handoffRequested = this.processHandoffToolCalls(execResult.toolCalls, sharedState); // Uses the modified processHandoffToolCalls
    if (handoffRequested && sharedState.handoffRequested) {
      const edgeId = sharedState.handoffRequested.edgeId;
      log.info(`Handoff requested via tool call, returning edge ID: ${edgeId}`);
      // The service layer will clear sharedState.handoffRequested after transition
      return edgeId; // Return the edgeId as the action for handoff
    }

    // If no handoff, check for other tool calls (excluding handoff tools already processed)
    const nonHandoffToolCalls = execResult.toolCalls?.filter(tc => !tc.name.startsWith('handoff_to_'));
    if (nonHandoffToolCalls && nonHandoffToolCalls.length > 0) {
      log.info('Non-handoff tool calls detected, returning TOOL_CALL_ACTION');
      return TOOL_CALL_ACTION; // Return tool call action
    }

    // --- Tier 2b: deterministic conditioned routing -------------------------
    // GATED: only runs when this node has at least one conditioned outgoing edge.
    // A node whose edges are all bare is byte-for-byte unchanged (model-decided
    // handoff above; terminate on plain text below). Precedence: a model handoff
    // tool call (handled above at :673) always wins; conditions decide otherwise.
    const edgeConditions = node_params?.edgeConditions;
    if (edgeConditions && Object.keys(edgeConditions).length > 0) {
      const ordered = this.orderedControlEdges(node_params);

      // First matching predicate wins, in author order.
      for (const edgeId of ordered) {
        const cond = edgeConditions[edgeId];
        if (!cond) continue;
        const text = selectConditionText(sharedState.messages, cond.target);
        if (evaluateCondition(cond, text)) {
          log.info('Deterministic edge condition matched; routing', { edgeId, kind: cond.kind });
          return edgeId;
        }
      }

      // No predicate matched → take the first BARE (predicate-less) edge as the
      // default/fallback, if any.
      const bare = ordered.find((edgeId) => !edgeConditions[edgeId]);
      if (bare) {
        log.info('No edge condition matched; routing to bare fallback edge', { edgeId: bare });
        return bare;
      }

      // Conditioned node, nothing matched, no fallback → fall through and
      // terminate (FINAL_RESPONSE_ACTION), same as an unmatched plain response.
      log.info('Conditioned node: no predicate matched and no bare fallback; terminating');
    }

    // If no error, no handoff, and no other tool calls, it's a final response for this step
    log.info('No tool calls or handoff requested, returning FINAL_RESPONSE_ACTION');
    return FINAL_RESPONSE_ACTION; // Return final response action
  }

  _clone(): BaseNode {
    return new ProcessNode();
  }
}
