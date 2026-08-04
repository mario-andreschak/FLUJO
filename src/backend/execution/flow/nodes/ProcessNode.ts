// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { ToolHandler } from '../handlers/ToolHandler';
import { ModelHandler } from '../handlers/ModelHandler';
import { ResourceHandler } from '../handlers/ResourceHandler';
import { buildRunResourceTools, buildReadResourceTool, READ_RESOURCE_TOOL_NAME, WRITE_RESOURCE_TOOL_NAME } from '../handlers/runResourceTools';
import { buildQuestionTool, QUESTION_TOOL_NAME } from '../handlers/runQuestionTool';
import { buildTodoTool, TODO_TOOL_NAME, formatTodoBlock } from '../handlers/todoTool';
import { isWhollyDenied } from '../permissionEngine';
import { buildListMCPResourcesTool, LIST_MCP_RESOURCES_TOOL_NAME } from '../handlers/mcpResourceTools';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import { buildNodeContext, scopeMessagesForInput, collapseNodeOutputs, deriveModelInputView } from '../buildNodeContext';
import { resolveFrozenSystemPrompt } from '../systemPromptDrift';
import { buildHandoffDescription } from '../buildHandoffDescription';
import { buildHandoffToolNameMap } from '@/shared/utils/handoffNaming';
import { flowService } from '@/backend/services/flow/index';
import { modelService } from '@/backend/services/model';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { FlowNode } from '@/shared/types/flow';
import { FEATURES } from '@/config/features'; // Import feature flags
import { PermissionRule } from '@/shared/types/permissions';
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
import { resolveNonSecretGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { resolveKvNodeRefs, captureKvValue, type KvFlowContext } from '../resolveKvNodeRefs';
import { withMcpAppModelContext } from '@/backend/mcpApps/modelContext';
import type { DecodedTool } from '../handlers/toolNamespace';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/ProcessNode');

/**
 * Providers report unsupported tool use through several shapes: an OpenAI SDK
 * APIError, an OpenRouter in-band error object, or FLUJO's normalized model
 * error. Match only explicit tool-capability failures so authentication,
 * routing, rate-limit, and generic 4xx errors are never retried with a
 * materially different request.
 */
function isUnsupportedToolUseError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined;
  let details = '';
  try {
    details = JSON.stringify(record?.details ?? record ?? '');
  } catch {
    // The normalized message/code below are sufficient if provider details are
    // circular or otherwise not serializable.
  }
  const haystack = [
    error instanceof Error ? error.message : '',
    typeof record?.message === 'string' ? record.message : '',
    typeof record?.code === 'string' ? record.code : '',
    typeof record?.type === 'string' ? record.type : '',
    details,
  ].join(' ').toLowerCase();

  return (
    haystack.includes('no endpoints found that support tool use') ||
    haystack.includes('no endpoint found that supports tool use') ||
    haystack.includes('tool use is not supported') ||
    haystack.includes('tool use not supported') ||
    haystack.includes('tools are not supported') ||
    haystack.includes('tools not supported') ||
    haystack.includes('does not support tool use') ||
    haystack.includes('does not support tools') ||
    haystack.includes('function calling is not supported') ||
    haystack.includes('tools_not_supported') ||
    haystack.includes('tool_use_not_supported') ||
    haystack.includes('unsupported_tool_use')
  );
}

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
    sharedState.handoffTargetTypes = sharedState.handoffTargetTypes || {};

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
      sharedState.handoffTargetTypes[target.id] = target.type;

      const flowNode = flowNodesById?.get(target.id);
      const description = flowNode
        ? await buildHandoffDescription(flowNode)
        : `Hand off execution to ${target.label} (${target.type})`;

      // A subflow OR process node in 'isolated' inputMode that opted into
      // `allowCallerPrompt` (issue #96) lets the routing model pass an
      // instruction message THROUGH the handoff to the target — so an isolated
      // process step can receive a message from the previous node, exactly like
      // an isolated subflow. Only those targets get a `prompt` parameter; every
      // other handoff tool stays byte-identically parameter-less (preserving the
      // provider prefix-cache stability from #89). The param is OPTIONAL: the
      // model may still route with no prompt, in which case the target's authored
      // isolated message (promptTemplate for a subflow, isolatedPrompt for a
      // process node) is used as the default (see SubflowNode.prep /
      // ProcessNode.prep).
      const targetProps = flowNode?.data?.properties as { inputMode?: string; allowCallerPrompt?: boolean; promptTemplate?: string; isolatedPrompt?: string } | undefined;
      // Every Subflow is a queue-backed sub-agent. The routing model may call the
      // same handoff tool any number of times in ONE turn; each call contributes
      // one job for this node's single child flow. `concurrencyLimit` on the
      // Subflow controls only how many jobs are active at once — it never limits
      // how many calls are accepted. runFlow captures all matching calls and
      // SubflowNode.prep turns them into an ordered job queue.
      const acceptsCallerSpawn = target.type === 'subflow';
      const acceptsCallerPrompt =
        (target.type === 'subflow' || target.type === 'process') &&
        targetProps?.inputMode === 'isolated' &&
        targetProps?.allowCallerPrompt !== false;
      // The target's OWN authored isolated message, used to decide whether a
      // caller prompt is mandatory: a subflow authors it as `promptTemplate`, a
      // process node as `isolatedPrompt`.
      const authoredIsolatedMessage =
        target.type === 'subflow' ? targetProps?.promptTemplate : targetProps?.isolatedPrompt;
      // Issue #169: for a NON-spawn, isolated, allowCallerPrompt target that has
      // NO authored message on the node itself, the caller MUST supply a prompt —
      // otherwise the target starts with an empty prompt and the chain dies
      // silently. In that exact configuration we mark `prompt` as JSON-Schema
      // `required`, turning a silent runtime dead-end into a schema-enforced
      // guarantee. Every other configuration keeps `prompt` optional as before.
      const promptIsMandatory = acceptsCallerPrompt && !acceptsCallerSpawn && !(authoredIsolatedMessage?.trim());
      const taskIsMandatory =
        acceptsCallerSpawn &&
        targetProps?.inputMode === 'isolated' &&
        !(authoredIsolatedMessage?.trim());

      const paramProps: Record<string, unknown> = {};
      const requiredParams: string[] = [];
      const descExtras: string[] = [];
      if (target.type === 'signal') {
        paramProps.body = {
          type: "string",
          minLength: 1,
          description: "REQUIRED non-empty payload body to emit with the signal. You MUST supply the signal data for this handoff."
        };
        requiredParams.push('body');
        descExtras.push('You MUST pass a non-empty "body" argument; it becomes the emitted signal payload.');
      } else if (acceptsCallerSpawn) {
        // `task` subsumes `prompt` for Subflow targets. One call is a normal
        // handoff; repeated calls form a queue of independently briefed jobs.
        paramProps.task = {
          type: "string",
          description: taskIsMandatory
            ? "REQUIRED task for this child run. This isolated subflow has no default instruction."
            : "Task for this child run. Optional; omit it (and call the tool once) to use the subflow's configured input."
        };
        if (taskIsMandatory) requiredParams.push('task');
        descExtras.push(
          'QUEUED SUB-AGENT: You may call this tool MULTIPLE TIMES in the SAME response — each call queues one child run with its own "task". The Subflow runs up to its configured maximum simultaneously, keeps pulling queued jobs until all are finished, and merges results in call order. To split work, make one call per self-contained task.'
        );
      } else if (acceptsCallerPrompt) {
        paramProps.prompt = {
          type: "string",
          description: promptIsMandatory
            ? "REQUIRED initial brief/instruction for the target node (isolated mode). It has no authored message of its own, so you MUST supply what it should work on — omitting it makes the target start with an empty prompt and stall."
            : "Instruction/prompt to run the target node with (isolated mode). Optional; omitted falls back to the target's default prompt."
        };
        if (promptIsMandatory) {
          requiredParams.push('prompt');
          descExtras.push('You MUST pass a "prompt" argument instructing the target node — it has no authored message of its own.');
        } else {
          descExtras.push('Optionally pass a "prompt" argument to instruct the target node; omit it to use its default prompt.');
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
    // scratchpad AFTER rendering. Tier 3 then injects `${res:NAME}` resources.
    let completePrompt = await resolveRunResourceRefs(
      resolveRunVars(renderedPrompt, sharedState.variables),
      sharedState.ephemeral ? undefined : sharedState.conversationId,
      sharedState.emit,
      { nodeId }
    );

    // Resolve configuration globals at execution time. The prompt-safe resolver
    // deliberately leaves secret globals as `${global:NAME}` so their values are
    // never sent to the model.
    completePrompt = await resolveNonSecretGlobalVars(completePrompt) as string;

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

    // Hoisted out of the else-branch below: the bound MCP nodes are needed for
    // resource-tool dispatch and for the synthetic-tool arming decision
    // regardless of whether the tool DEFINITIONS came from shared state or from a
    // fresh processMCPNodes call. (Previously this only ran on the fresh path, so
    // a step served from sharedState.mcpContext lost its server routing context.)
    const mcpNodes = node_params?.properties?.mcpNodes || [];

    // Issue #239: store mcpNodes for resource-tool dispatch at tool-call time.
    sharedState.currentMCPNodes = mcpNodes.length > 0 ? mcpNodes : undefined;

    // Issue #246: Build merged permission rules from flow-level rules + autoApprove
    // desugaring. Stored in SharedState so ModelHandler can evaluate them per-call.
    // Done once per node visit (prep re-runs on tool loop iterations, which is fine
    // since the rules are idempotent).
    {
      let flowLevelRules: PermissionRule[] = [];
      try {
        const flowForPermissions = await flowService.getFlow(flowId);
        flowLevelRules = flowForPermissions?.permissionRules ?? [];
      } catch (err) {
        log.warn('Could not load flow for permission rules', { err });
      }

      // Desugar autoApprove from each bound MCP server's config:
      // autoApprove: ['tool1', 'tool2'] → [{action:'tool1',resource:'*',effect:'allow'}, ...]
      const autoApproveRules: PermissionRule[] = [];
      if (mcpNodes.length > 0) {
        try {
          const allConfigs = await loadServerConfigs();
          if (Array.isArray(allConfigs)) {
            for (const mcpNode of mcpNodes) {
              const serverName = mcpNode.properties.boundServer;
              if (!serverName) continue;
              const serverConfig = allConfigs.find(c => c.name === serverName);
              if (serverConfig?.autoApprove?.length) {
                for (const toolName of serverConfig.autoApprove) {
                  autoApproveRules.push({ action: toolName, resource: '*', effect: 'allow' });
                }
              }
            }
          }
        } catch (err) {
          log.warn('Could not load MCP server configs for autoApprove desugaring', { err });
        }
      }

      // Merge: autoApprove first (lower priority), flow-level rules after (higher priority).
      // Flow-level deny rules beat any autoApprove allows (last-match-wins semantics).
      sharedState.permissionRules = [...autoApproveRules, ...flowLevelRules];
    }

    if (sharedState.mcpContext && sharedState.mcpContext.availableTools && sharedState.mcpContext.availableTools.length > 0) {
      // Use tools already processed by MCPNode
      log.info('Using MCP tools from shared state', {
        toolsCount: sharedState.mcpContext.availableTools.length
      });
      availableTools = sharedState.mcpContext.availableTools;
    } else {
      if (mcpNodes.length > 0) {
        log.info('No MCP tools found in shared state, processing MCP nodes', {
          mcpNodesCount: mcpNodes.length
        });

        // Phase 2 (issue #246): build merged permission rules before fetching tools
        // so wholly-denied tools are dropped from the advertised list.
        const mcpResult = await ToolHandler.processMCPNodes({
          mcpNodes,
          permissionRules: sharedState.permissionRules,
        });

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

    // Question tool (issue #258): offer the synthetic `question` tool only when
    // this Process node explicitly opts in (`allowQuestion`). Unlike
    // read_resource it is NOT sticky-armed via armedSyntheticTools — it is
    // offered iff enabled, so flows that don't use it keep a byte-identical tool
    // set (preserving the #89 prefix-cache) and unattended flows can leave it
    // off entirely.
    // A flow-level `deny` rule for action `question` (isWhollyDenied) removes it
    // even when the node opted in — satisfies AC#3 (disable for unattended /
    // headless), mirroring how MCP tools are dropped in ToolHandler.
    const questionDenied = isWhollyDenied(sharedState.permissionRules ?? [], QUESTION_TOOL_NAME);
    if (node_params?.properties?.allowQuestion === true && !questionDenied &&
        !availableTools.some((t) => t.name === QUESTION_TOOL_NAME)) {
      availableTools = [...availableTools, buildQuestionTool()];
    }

    // Todo tool (issue #259): offer the synthetic `todo` tool only when this
    // Process node opts in (`enableTodoTool`). Like the question tool, it is
    // offered iff enabled (not sticky-armed), so flows that don't use it keep a
    // byte-identical tool set (preserving the #89 prefix-cache). A flow-level
    // `deny` rule for action `todo` removes it even when the node opted in.
    const todoDenied = isWhollyDenied(sharedState.permissionRules ?? [], TODO_TOOL_NAME);
    if (node_params?.properties?.enableTodoTool === true && !todoDenied &&
        !availableTools.some((t) => t.name === TODO_TOOL_NAME)) {
      availableTools = [...availableTools, buildTodoTool()];
    }

    // Record the model-facing-name -> (server, tool) mapping for MCP tools so the
    // model's tool calls can be decoded later, including across a tool-approval
    // resume (#16). Handoff tools have no server and are decoded by name prefix.
    sharedState.toolNameMap = sharedState.toolNameMap || {};
    for (const tool of availableTools) {
      if (tool.server && tool.originalName) {
        // Issue #255: carry the advertise-time identity (client generation +
        // schema hash) so a stale dispatch after a reconnect is rejected.
        sharedState.toolNameMap[tool.name] = {
          server: tool.server,
          tool: tool.originalName,
          timeout: tool.timeout,
          nodeId: tool.nodeId,
          clientGeneration: tool.clientGeneration,
          schemaHash: tool.schemaHash,
          annotations: tool.annotations,
          uiResourceUri: tool.uiResourceUri,
        };
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
    runId: sharedState.logicalRunId,
    codexSession: sharedState.codexSessions?.[nodeId],
    onCodexSessionChange: (session) => {
      if (session) {
        sharedState.codexSessions = { ...(sharedState.codexSessions ?? {}), [nodeId]: session };
      } else if (sharedState.codexSessions?.[nodeId]) {
        const { [nodeId]: _removed, ...remaining } = sharedState.codexSessions;
        sharedState.codexSessions = Object.keys(remaining).length > 0 ? remaining : undefined;
      }
    },
    requireToolApproval: sharedState.requireApproval ?? false,
    // Issue #258: carry the resolved unattended flag so execCore can pass it to
    // the model call (the synthetic `question` tool degrades in unattended runs).
    unattended: sharedState.unattended,
  };

    // Prompt-cache stability (issue #249): FREEZE the assembled system prompt
    // per (conversation, node) on first render and re-send it byte-identically
    // thereafter, so it forms a stable provider cache prefix (mirrors the #89
    // tool-block freeze). Drift in `${resource:}` / `${kv:}` pills (or a future
    // date injection) must NOT mutate the frozen prefix — that would invalidate
    // the provider's prefix cache — so it is surfaced to the model as a synthetic
    // `[System update]` tail message instead. Re-frozen only at a compaction
    // boundary (where the prefix is rebuilt anyway).
    const freeze = resolveFrozenSystemPrompt(
      nodeId,
      completePrompt,
      sharedState.frozenSystemPrompts,
      sharedState.messages
    );
    sharedState.frozenSystemPrompts = freeze.frozenSystemPrompts;
    const systemPromptContent = freeze.content;
    if (freeze.frozeNow) {
      log.info('Froze system prompt for node (first render)', {
        nodeId,
        length: completePrompt.length,
      });
    }
    if (freeze.driftUpdate !== undefined) {
      // Surface the drift to the model as a synthetic `[System update]` tail
      // message instead of mutating the frozen prefix (which would bust the
      // provider prefix cache). Dedupe is handled inside resolveFrozenSystemPrompt.
      sharedState.messages.push({
        id: uuidv4(),
        role: 'user',
        content: freeze.driftUpdate,
        timestamp: Date.now(),
      });
      log.info('System prompt drifted from frozen prefix; appended [System update]', {
        nodeId,
      });
    }
    // Keep prepResult.currentPrompt consistent with the (possibly frozen) content
    // actually sent on the wire.
    prepResult.currentPrompt = systemPromptContent;

    // Create our own system message with the (frozen) prompt as FlujoChatMessage
    const systemMessage: FlujoChatMessage = {
      id: uuidv4(), // Generate unique ID
      role: 'system',
      content: systemPromptContent,
      timestamp: Date.now() // Add timestamp
    };

    log.info('Added system message from prompt template', {
      contentLength: systemPromptContent.length,
      contentPreview: systemPromptContent.length > 100 ?
        systemPromptContent.substring(0, 100) + '...' : systemPromptContent
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
    // Caller handoff input (issue #96): the single-shot, node-id-scoped `prompt`
    // an upstream routing model passed via the handoff tool — the same value
    // SubflowNode.prep reads. It lets an ISOLATED process node receive a message
    // handed to it by the previous node, exactly like an isolated subflow. Read
    // WITHOUT clearing: a Process node's tool loop re-runs prep() on every
    // iteration (runFlow re-enters the node), so clearing here would lose the
    // caller prompt mid-loop. runFlow resets handoffInput at each handoff
    // transition, so it stays scoped to this node's visit and never leaks to a
    // later node or a subsequent turn.
    const handoffForThisNode =
      sharedState.handoffInput && sharedState.handoffInput.targetNodeId === node_params?.id
        ? sharedState.handoffInput
        : undefined;
    // Claude's experimental session resume tracks a message-count watermark. An
    // output-folded history from another node no longer aligns with it, so keep
    // the full history for this eligible call. Explicit input scoping remains
    // unsafe and continues through the normal wire-view path below.
    let preserveFullHistoryForClaudeResume = false;
    if (inputMode === 'full-history') {
      try {
        const model = await modelService.getModel(boundModel);
        preserveFullHistoryForClaudeResume =
          model?.adapter === 'claude-cli' &&
          await ModelHandler.isClaudeSessionResumeEnabled();
      } catch (err) {
        // If the model cannot be resolved, retain the established folding behavior.
        log.warn('Could not determine Claude session-resume compatibility', { err });
      }
    }

    let wireBase = prepResult.messages;
    if (!preserveFullHistoryForClaudeResume) {
      try {
        const flow = await flowService.getFlow(flowId);
        const collapsedNodeIds = new Set(
          (flow?.nodes ?? [])
            .filter((n) => n.type === 'process' && n.data?.properties?.outputMode === 'latest-message')
            .map((n) => n.id)
        );
        wireBase = collapseNodeOutputs(wireBase, collapsedNodeIds);
      } catch (err) {
        // Collapsing is a context-token optimization — never block the run on it.
        log.warn('Could not resolve outputMode collapse set; sending the full wire view', { err });
      }
    }

    // Chat references are a wire-only projection: preserve canonical serialized
    // pills in SharedState.messages, but expand only resources authorized for
    // this ProcessNode and non-secret globals before the model sees them.
    if (wireBase.some((message) =>
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('${')
    )) {
      wireBase = await Promise.all(wireBase.map(async (message): Promise<FlujoChatMessage> => {
        if (message.role !== 'user' || typeof message.content !== 'string') return message;
        let content = await promptRenderer.resolveChatMessageReferences(
          message.content,
          mcpNodes,
          (info) => sharedState.emit?.({
            type: 'resource:read',
            node: { nodeId },
            source: 'pill',
            ...info,
          }),
        );
        content = await resolveRunResourceRefs(
          content,
          sharedState.ephemeral ? undefined : sharedState.conversationId,
          sharedState.emit,
          { nodeId },
        );
        return content === message.content
          ? message
          : { ...message, content } as FlujoChatMessage;
      }));
    }

    if (inputMode !== 'full-history' || wireBase !== prepResult.messages) {
      // Tier 2c: resolve `${var:NAME}` in the isolated prompt too (wire-only text,
      // like the system prompt) so an isolated step can pull captured state.
      // Tier 3: `${res:NAME}` likewise.
      // Isolated mode: when this node opted into `allowCallerPrompt` (issue #96,
      // default ON) and the routing model passed a `prompt` via the handoff tool,
      // that caller-supplied message OVERRIDES the authored `isolatedPrompt`
      // (which stays the default/fallback) — mirroring the isolated subflow path.
      const allowCallerPrompt = node_params?.properties?.allowCallerPrompt !== false;
      const callerPrompt = allowCallerPrompt ? handoffForThisNode?.prompt?.trim() : undefined;
      if (callerPrompt) {
        log.info('Using caller-supplied prompt for isolated process node', { nodeId });
      }
      const isolatedPrompt = callerPrompt || node_params?.properties?.isolatedPrompt;
      let resolvedIsolatedPrompt = isolatedPrompt !== undefined
        ? await resolveRunResourceRefs(
            resolveRunVars(isolatedPrompt, sharedState.variables),
            sharedState.ephemeral ? undefined : sharedState.conversationId,
            sharedState.emit,
            { nodeId }
          )
        : isolatedPrompt;
      if (typeof resolvedIsolatedPrompt === 'string') {
        resolvedIsolatedPrompt = await resolveNonSecretGlobalVars(resolvedIsolatedPrompt) as string;
      }
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

    // MCP Apps: `ui/update-model-context` is future-turn context, not a chat
    // message. Add the latest per-app snapshots to the wire view only, directly
    // before the current user input, so they neither appear in nor mutate the
    // persisted transcript. This also keeps overwrite semantics: exactly one
    // synthetic message is generated from the current map on every prep.
    const contextBase = prepResult.wireMessages ?? wireBase;
    const withAppContext = withMcpAppModelContext(
      contextBase,
      sharedState.mcpAppContexts,
    );
    if (withAppContext !== contextBase) {
      prepResult.wireMessages = withAppContext;
    }

    // Issue #168 / #239: expose the synthetic `read_resource` tool so the model
    // can dereference a `flujo://run/...` marker (left by an oversized captured
    // tool result/args, or by compaction) back to full content — even when the
    // flujo MCP server isn't attached — and can fetch native MCP resource URIs it
    // discovers via list_mcp_resources.
    //
    // Arming is FRONT-LOADED and MONOTONE, for prefix-cache stability (#89).
    // The original gate armed the tool the first turn a `flujo://run/` URI showed
    // up on the wire. That is inherently a mid-conversation flip: turn N has no
    // URI and turn N+1 does, so the tool block — which serializes AHEAD of the
    // messages — changes shape exactly once per run, invalidating the ENTIRE
    // provider prefix cache on that turn. Since compaction can mint a URI from
    // any oversized tool result, "a URI might appear later" is true for
    // essentially every tool-using step, so waiting for the marker bought no
    // token saving and cost a guaranteed full cache miss.
    //
    // Instead: decide from conditions known AT PREP TIME, before any URI exists —
    // does this step have MCP tools (whose results can be captured/compacted into
    // a URI), a write_resource tool, wired resource nodes, or native resources?
    // Resource-free, tool-free steps still get a byte-identical tool set to
    // before, which is what the original gate was protecting.
    const wireForScan = prepResult.wireMessages ?? wireBase;
    // Retained for conversations RESUMED from before this change, whose history
    // already carries a URI but whose step might not match the conditions below.
    const historyHasRunResourceUri = wireForScan.some((message) => {
      // A materialized media URI is transport metadata: the next model receives
      // its localPath as an artifact descriptor and, when supported, the bytes
      // are hydrated automatically. Only unresolved media still needs the
      // read_resource escape hatch. Other URI markers in message/tool content
      // remain model-visible and continue to arm the tool.
      const { media, ...modelVisibleMessage } = message;
      if (JSON.stringify(modelVisibleMessage).includes(RUN_RESOURCE_SCHEME)) return true;
      return media?.some(
        part => part.resourceUri?.startsWith(RUN_RESOURCE_SCHEME) && !part.localPath,
      ) ?? false;
    });
    const hasMcpTools = availableTools.some((t) => !!t.server);
    const hasWriteResource = availableTools.some((t) => t.name === WRITE_RESOURCE_TOOL_NAME);
    const hasResourceNodes = (node_params?.properties?.resourceNodes?.length ?? 0) > 0;
    const hasNativeResources = availableTools.some(
      (t) => t.name === LIST_MCP_RESOURCES_TOOL_NAME,
    );
    const shouldArmReadResource =
      hasMcpTools ||
      hasWriteResource ||
      hasResourceNodes ||
      hasNativeResources ||
      historyHasRunResourceUri;

    // Sticky arming: a synthetic tool offered once on this conversation keeps
    // being offered. Guards the reverse flip — e.g. a server's resource listing
    // succeeding on turn 1 (arming list_mcp_resources) and throwing on turn 2,
    // which would otherwise drop the tool and rewrite the block.
    const armed = new Set(sharedState.armedSyntheticTools ?? []);
    if (shouldArmReadResource) armed.add(READ_RESOURCE_TOOL_NAME);
    if (hasNativeResources) armed.add(LIST_MCP_RESOURCES_TOOL_NAME);

    // prepResult.availableTools is the same array reference, so these are picked
    // up by execCore's toolNameMap build and the model call.
    if (armed.has(READ_RESOURCE_TOOL_NAME) &&
        !availableTools.some((t) => t.name === READ_RESOURCE_TOOL_NAME)) {
      availableTools.push(buildReadResourceTool());
    }
    if (armed.has(LIST_MCP_RESOURCES_TOOL_NAME) && mcpNodes.length > 0 &&
        !availableTools.some((t) => t.name === LIST_MCP_RESOURCES_TOOL_NAME)) {
      // Rebuilt from configuration only (no re-probe), so the bytes match the
      // definition emitted on the turn that armed it.
      log.info('Re-arming list_mcp_resources from sticky state (probe unavailable this turn)');
      availableTools.push(buildListMCPResourcesTool(mcpNodes));
    }

    if (armed.size > 0) {
      sharedState.armedSyntheticTools = Array.from(armed).sort();
    }

    // Todo tool (issue #259): re-inject the current run-scoped task list into the
    // model's view each turn, so intent survives a compacting history. Appended
    // as a WIRE-ONLY user message (prepResult.messages / persisted transcript is
    // untouched, like the isolated/scoped wire views) rather than into the FROZEN
    // system prompt (#249) — mutating that prefix every time a status flips would
    // bust the provider prefix cache. Only emitted once the list is non-empty, so
    // a todo-enabled node with no tasks yet keeps a byte-identical wire view.
    if (node_params?.properties?.enableTodoTool === true && (sharedState.todos?.length ?? 0) > 0) {
      const todoBlock = formatTodoBlock(sharedState.todos);
      if (todoBlock) {
        const base = prepResult.wireMessages ?? wireBase;
        prepResult.wireMessages = [
          ...base,
          {
            id: uuidv4(),
            role: 'user',
            content: todoBlock,
            timestamp: Date.now(),
          } as FlujoChatMessage,
        ];
      }
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

    // Graceful landing (issue #253): when runFlow has flagged this as the forced
    // final summary turn (the agentic-turn budget was exhausted), strip EVERY
    // tool so the model can only produce a text-only summary. The forced summary
    // instruction + synthetic tool-results were already appended to the history
    // by runFlow, so prepResult.messages already carries them.
    if (sharedState.forceSummaryTurn) {
      log.info(`[ProcessNode ${prepResult.nodeId}] Forced summary turn: stripping all tools for graceful landing (#253).`);
      prepResult.availableTools = [];
      prepResult.forceSummaryTurn = true;
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
      let tools: OpenAI.ChatCompletionFunctionTool[] | undefined = undefined; // Initialize tools

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
      const toolNameMap: Record<string, DecodedTool> = {};
      for (const t of prepResult.availableTools ?? []) {
        if (t.server && t.originalName) {
          // Issue #255: preserve the identity token for the adapter dispatch path too.
          toolNameMap[t.name] = {
            server: t.server,
            tool: t.originalName,
            timeout: t.timeout,
            nodeId: t.nodeId,
            clientGeneration: t.clientGeneration,
            schemaHash: t.schemaHash,
            annotations: t.annotations,
            uiResourceUri: t.uiResourceUri,
          };
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
      let usedToolFreeFallback = false;
      try {
        const callModelWithTools = (attemptTools: OpenAI.ChatCompletionFunctionTool[] | undefined) =>
          ModelHandler.callModel({
            modelId: prepResult.boundModel,
            prompt: prepResult.currentPrompt,
            messages: prepResult.messages,
            // Scoped view for latest-message / isolated inputMode; when unset the
            // model sees `messages` verbatim (full-history). Persistence always uses
            // the full `messages`, never this.
            wireMessages: prepResult.wireMessages,
            tools: attemptTools,
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
            // Thread the existing Process-node summarizing-compaction settings;
            // ModelHandler previously resolved them with `undefined` (#356).
            compactionMode: node_params?.properties?.compactionMode,
            compactionKeepTokens: node_params?.properties?.compactionKeepTokens,
            onFinalWire: prepResult.modelInput
              ? (finalWire, visualCompaction) => {
                  const captured = finalWire.map((message, index) => ({
                    ...message,
                    id: `final-wire-${prepResult.nodeId}-${index}`,
                    timestamp: Date.now(),
                    content: Array.isArray(message.content)
                      ? message.content.map((part) => {
                          if (part && typeof part === 'object' && 'image_url' in part) {
                            const image = (part as { image_url?: { url?: string } }).image_url;
                            return { type: 'text' as const, text: `[image omitted from debugger snapshot: ${image?.url?.slice(0, 32) ?? 'unknown'}…]` };
                          }
                          return part;
                        })
                      : message.content,
                  })) as FlujoChatMessage[];
                  prepResult.modelInput!.wireMessages = captured;
                  if (visualCompaction) {
                    visualCompaction.finalWireCaptured = true;
                    prepResult.modelInput!.visualCompaction = visualCompaction;
                  }
                  prepResult.modelInputs = [prepResult.modelInput!];
                }
              : undefined,
            nodeName, // Pass the node name to be included in the response header
            nodeId: prepResult.nodeId, // Pass the node ID
            toolNameMap, // Lets self-orchestrating adapters dispatch tool calls to mcpService
            conversationId: prepResult.conversationId, // For mid-run tool-approval prompts
            runId: prepResult.runId,
            codexSession: prepResult.codexSession,
            onCodexSessionChange: prepResult.onCodexSessionChange,
            requireToolApproval: prepResult.requireToolApproval, // Gate tool calls on user approval
            mcpNodes: node_params?.properties?.mcpNodes, // Issue #239: for native resource tools
            unattended: prepResult.unattended, // Issue #258: degrade the question tool in unattended runs
          });

        // Provider catalogues can tell us before the request that a model lacks
        // tool support. Strip only handoff-only plumbing when routing remains
        // deterministic; executable/MCP tools are never silently removed.
        let initialTools = tools;
        if (
          this.canRunWithoutTools(prepResult, node_params, tools) &&
          await this.discoverBoundModelToolSupport(prepResult) === false
        ) {
          log.info(
            `[ProcessNode ${prepResult.nodeId}] Provider metadata reports no tool support; calling without handoff-only tools`,
          );
          initialTools = undefined;
          usedToolFreeFallback = true;
        }

        // Unknown capabilities retain the error-driven compatibility fallback
        // below because many OpenAI-compatible providers expose only id/name.
        modelResult = await callModelWithTools(initialTools);

        // Retry exactly once without tools, but only when the removed block is
        // entirely handoff plumbing and the engine can route the plain response
        // deterministically. MCP and synthetic/executable tools are never
        // silently removed.
        if (
          !modelResult.success &&
          initialTools !== undefined &&
          this.canRetryWithoutTools(prepResult, node_params, tools, modelResult.error)
        ) {
          log.warn(
            `[ProcessNode ${prepResult.nodeId}] Provider rejected handoff-only tools; retrying once without tools`,
            {
              controlEdges: this.orderedControlEdges(node_params),
              conditionedEdges: Object.keys(node_params?.edgeConditions ?? {}),
            }
          );
          modelResult = await callModelWithTools(undefined);
          usedToolFreeFallback = modelResult.success;
        }


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
        toolCalls: result.toolCalls,
        // #253: carry the resolved turn cap out so post() can record it on
        // SharedState.turnBudgets for runFlow's per-node turn counter.
        effectiveMaxTurns: result.effectiveMaxTurns,
        // Lets post() traverse a sole bare edge when this successful response
        // came from the safe, handoff-free provider retry.
        usedToolFreeFallback,
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

  /**
   * A tool-free response can still advance when routing is engine-owned:
   * conditioned edges are evaluated from the returned text, while a sole bare
   * edge is unambiguous and can be traversed by post(). Multiple bare edges
   * still require the model to choose a handoff and are therefore ineligible.
   */
  private hasAutomaticToolFreeRoute(node_params?: ProcessNodeParams): boolean {
    const controlEdges = this.orderedControlEdges(node_params);
    const conditions = node_params?.edgeConditions;
    const hasConditionedEdge = controlEdges.some((edgeId) => !!conditions?.[edgeId]);
    const hasSingleBareEdge =
      controlEdges.length === 1 && !conditions?.[controlEdges[0]];
    return hasConditionedEdge || hasSingleBareEdge;
  }

  private canRunWithoutTools(
    prepResult: ProcessNodePrepResult,
    node_params: ProcessNodeParams | undefined,
    tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
  ): boolean {
    if (!tools?.length) return false;
    if ((node_params?.properties?.mcpNodes?.length ?? 0) > 0) return false;
    if (!this.hasAutomaticToolFreeRoute(node_params)) return false;

    const definitions = prepResult.availableTools ?? [];
    return (
      definitions.length > 0 &&
      definitions.every((tool) => !tool.server && tool.name.startsWith('handoff_to_')) &&
      tools.every(
        (tool) => tool.type === 'function' && tool.function.name.startsWith('handoff_to_')
      )
    );
  }

  /**
   * Prefer persisted capability metadata. For legacy OpenRouter models saved
   * before discovery existed, consult the cached provider catalogue so the very
   * first execution can avoid a known-invalid tool request too.
   */
  private async discoverBoundModelToolSupport(
    prepResult: ProcessNodePrepResult,
  ): Promise<boolean | undefined> {
    try {
      const model = await modelService.getModel(prepResult.boundModel);
      if (!model) return undefined;
      if (model.supportsTools !== undefined) return model.supportsTools;
      if (model.provider !== 'openrouter' || !model.baseUrl) return undefined;

      const discovered = await modelService.fetchProviderModels(
        model.baseUrl,
        model.id,
        model.name,
      );
      return discovered.find(candidate => candidate.id === model.name)?.supportsTools;
    } catch (error) {
      log.warn('Could not discover bound-model tool capability; using provider fallback', {
        modelId: prepResult.boundModel,
        error,
      });
      return undefined;
    }
  }

  /**
   * Stripping tools is safe only when every advertised capability is routing
   * plumbing. A bound MCP node or any synthetic/executable tool keeps the
   * original failure: silently removing those tools would change the task.
   */
  private canRetryWithoutTools(
    prepResult: ProcessNodePrepResult,
    node_params: ProcessNodeParams | undefined,
    tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
    error: unknown
  ): boolean {
    return (
      isUnsupportedToolUseError(error) &&
      this.canRunWithoutTools(prepResult, node_params, tools)
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

    // Graceful landing (issue #253): record the effective agentic-turn cap this
    // node resolved so runFlow's request/response tool loop can enforce it and
    // land with a forced text summary once the budget is spent.
    if (execResult.success && typeof execResult.effectiveMaxTurns === 'number' && node_params?.id) {
      sharedState.turnBudgets = sharedState.turnBudgets ?? {};
      sharedState.turnBudgets[node_params.id] = execResult.effectiveMaxTurns;
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

    // A provider that cannot accept tools may have been retried without the
    // handoff-only tool block. In that exceptional path, one bare outgoing edge
    // is an unambiguous continuation and does not need a model-authored handoff.
    // This is deliberately marker-gated so ordinary all-bare nodes retain their
    // existing model-decided routing semantics.
    if (execResult.usedToolFreeFallback) {
      const ordered = this.orderedControlEdges(node_params);
      if (ordered.length === 1 && !edgeConditions?.[ordered[0]]) {
        log.info('Tool-free provider fallback: routing through sole bare edge', {
          edgeId: ordered[0],
        });
        return ordered[0];
      }
    }

    // If no error, no handoff, and no other tool calls, it's a final response for this step
    log.info('No tool calls or handoff requested, returning FINAL_RESPONSE_ACTION');
    return FINAL_RESPONSE_ACTION; // Return final response action
  }

  _clone(): BaseNode {
    return new ProcessNode();
  }
}
