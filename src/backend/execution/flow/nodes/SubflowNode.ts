import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import {
  SharedState,
  SubflowNodeParams,
  SubflowNodePrepResult,
  SubflowNodeExecResult,
  SubflowLanePlan,
  SubflowLaneResult,
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
} from '../types';
import { FEATURES } from '@/config/features';
import { FlujoChatMessage } from '@/shared/types/chat';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { resolveKvNodeRefs, captureKvValue } from '../resolveKvNodeRefs';
import { writeRunResource } from '@/backend/services/runResources';
import { isCancelledByAncestry } from '../cancellation';

const log = createLogger('backend/execution/flow/nodes/SubflowNode');

/** The dynamically-imported runFlow module type (import is lazy to break a cycle). */
type RunFlowModule = typeof import('../runFlow');
/** The single/lane input handed to runFlow (prep sets exactly one form). */
type SubflowRunInput = { messages: FlujoChatMessage[] } | { prompt: string };

/** True when a message carries real (non-empty) content. */
function hasContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

/**
 * Build the message list handed to a subflow from the parent conversation.
 *
 * A subflow runs another flow as a continuation of this conversation, so it
 * needs the genuine exchange — but NOT FLUJO's internal plumbing, which would
 * confuse the child's model (or be invalid against its own toolset):
 *   - drop system messages (the child's StartNode injects its own),
 *   - drop tool-result messages,
 *   - drop assistant messages that made tool calls (handoff or otherwise): they
 *     are mid-action turns whose results we're also dropping, so keeping their
 *     prose would dangle. In the router case this drops the "I'll hand this off"
 *     turn, leaving the history ending on the user's task so the child model
 *     responds to it naturally rather than prefilling an assistant turn,
 *   - drop processNodeId (parent node ids don't exist in the child flow),
 *   - keep user messages and prose-only assistant messages with real content.
 */
function sanitizeForSubflow(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  const out: FlujoChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'tool') continue;
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
      continue;
    }
    if (!hasContent(msg.content)) continue;
    const { processNodeId, ...rest } = msg as any;
    out.push({ ...rest });
  }
  return out;
}

/**
 * Scope a sanitized transcript to the current turn: everything from the most
 * recent user message ONWARD ('latest-message' inputMode, issue #74). An
 * orchestrator that hands off to a worker subflow on every loop iteration would
 * otherwise re-send the entire accumulated history — including already-finished
 * tasks — causing the worker to re-anchor on the earliest/loudest task. Slicing
 * from the last user message pins each invocation to the current task while
 * PRESERVING any trailing assistant/Process-node output for that turn (issue
 * #119): a Process node's produced instruction sits after the last user message,
 * so returning only `[sanitized[i]]` silently dropped it. This mirrors
 * `scopeMessagesForInput` in buildNodeContext.ts (the Process-node path) so the
 * two 'latest-message' implementations cannot diverge again. Finished earlier
 * tasks still precede the last user message, so #74's intent is intact. Falls
 * back to the full sanitized list when there is no user message (unusual, but
 * keeps the subflow fed).
 */
function latestUserMessage(sanitized: FlujoChatMessage[]): FlujoChatMessage[] {
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (sanitized[i].role === 'user') {
      return sanitized.slice(i);
    }
  }
  return sanitized;
}

/** Flatten a message's content down to plain text (map-over-list source). A
 *  multimodal content array keeps only its text parts. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof (part as any)?.text === 'string' ? (part as any).text : ''))
      .join('');
  }
  return '';
}

/**
 * Split the resolved subflow input into per-item strings for map-over-list mode
 * (Tier 2a). Each returned string becomes one child run's `prompt`.
 *   - 'lines': split on newlines; whitespace-only lines are dropped; each
 *     remaining line is trimmed into one item.
 *   - 'json-array' (default): parse the input as a JSON array; each element is
 *     one item (strings verbatim, objects/arrays re-stringified so the child
 *     receives valid JSON). Anything that is not a JSON array (parse error or a
 *     non-array value) yields NO items — the caller folds a clean "nothing to
 *     map" result rather than guessing.
 */
function splitItems(text: string, mode: 'json-array' | 'lines'): string[] {
  if (mode === 'lines') {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((el) => (typeof el === 'string' ? el : JSON.stringify(el)));
}

/**
 * Build the per-child `emit` wrapper that folds a subflow run's events onto the
 * PARENT conversation's channel.
 *
 * Every child event is forwarded at depth + 1 (wrappers COMPOSE, so a grandchild
 * arrives two deep). The child's run boundaries are translated to
 * subflow:start / subflow:done — a raw child `run:done` on the parent channel
 * would terminate the parent's SSE streams mid-run, so that safeguard is
 * preserved PER LANE. When `lane` is provided (parallel fan-out, issue #102),
 * every forwarded event is additionally stamped with `laneIndex`/`laneCount` so
 * concurrent lanes stay separable in the live view; when it is omitted the
 * output is identical to the single-child behavior (no lane fields).
 */
function buildChildEmit(
  parentEmit: EmitFn | undefined,
  showSteps: boolean,
  nodeRef: NodeRef,
  subflowId: string,
  subflowName: string | undefined,
  lane?: { index: number; count: number },
): EmitFn | undefined {
  if (!parentEmit || !showSteps) return undefined;
  const laneFields = lane ? { laneIndex: lane.index, laneCount: lane.count } : {};
  return (raw) => {
    const depth = (raw.depth ?? 0) + 1;
    if (raw.type === 'run:start') {
      parentEmit({ type: 'subflow:start', node: nodeRef, subflowId, subflowName, depth, ...laneFields });
      return;
    }
    if (raw.type === 'run:done') {
      parentEmit({ type: 'subflow:done', node: nodeRef, subflowId, status: raw.status, depth, ...laneFields });
      return;
    }
    if (raw.type === 'message') {
      // Stamp depth onto the message payload too: live consumers and the log
      // projection key nested display off message.depth.
      parentEmit({ ...raw, depth, message: { ...raw.message, depth }, ...laneFields });
      return;
    }
    parentEmit({ ...raw, depth, ...laneFields });
  };
}

/**
 * A node that runs another flow as a subroutine via the flow-as-callable
 * keystone (runFlow, ephemeral mode), then folds the subflow's output back into
 * the parent conversation and hands off to its successor.
 *
 * Input mapping (v1): an explicit `promptTemplate` property wins; otherwise the
 * subflow receives the parent conversation's latest message text.
 * Output mapping (v1): the subflow's final assistant text is appended to the
 * parent transcript as an assistant message attributed to this node, and set as
 * the parent's lastResponse.
 *
 * Isolation: the subflow runs in ephemeral state (nothing persisted to the
 * conversations store) at runDepth+1, so runFlow's depth guard stops infinite
 * recursion.
 */
export class SubflowNode extends BaseNode {
  async prep(sharedState: SharedState, node_params?: SubflowNodeParams): Promise<SubflowNodePrepResult> {
    const subflowId = node_params?.properties?.subflowId;
    const parallelIds = (node_params?.properties?.parallelSubflowIds ?? []).filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    );
    const mapOverList = node_params?.properties?.mapOverList === true;
    const itemSplit = node_params?.properties?.itemSplit === 'lines' ? 'lines' : 'json-array';
    const sequential = node_params?.properties?.sequential === true;
    const promptTemplate = node_params?.properties?.promptTemplate?.trim();
    // Back-compat: a promptTemplate saved before the explicit 'isolated' mode
    // existed used to override the history unconditionally. Preserve that by
    // treating "has a promptTemplate but no explicit inputMode" as isolated.
    const inputMode =
      node_params?.properties?.inputMode ?? (promptTemplate ? 'isolated' : 'full-history');
    const showSteps = node_params?.properties?.outputMode !== 'final-only';

    // 'isolated' mode sends `promptTemplate` as the subflow's single user prompt,
    // ignoring the parent conversation. Otherwise, pass the parent conversation so
    // the subflow continues with genuine context — either the full sanitized
    // history (default) or, in 'latest-message' mode, just the most recent user
    // instruction so each invocation is scoped to the current task (issue #74).
    const prepResult: SubflowNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'subflow',
      subflowId,
      depth: (sharedState.runDepth ?? 0) + 1,
      // Carry the parent run's event-chain depth unchanged (a subflow call is
      // not an event hop) so a `signal` node inside the child emits at the right
      // depth and maxChainDepth stays effective for nested signals (issue #117).
      chainDepth: sharedState.chainDepth ?? 0,
      parentRunId: sharedState.conversationId,
      showSteps,
      // The engine attaches the run's emit to sharedState for the duration of
      // this step; capturing it here lets execCore forward the child run's
      // events onto the PARENT conversation's channel, nested by depth.
      emit: sharedState.emit,
      nodeName: node_params?.properties?.name,
    };
    if (inputMode === 'isolated') {
      // Isolated mode sends a single authored prompt. When this node opted into
      // `allowCallerPrompt` (issue #96) and an upstream routing model passed a
      // `prompt` via the handoff tool, that caller prompt OVERRIDES the authored
      // `promptTemplate` (which becomes the default/fallback). The transient
      // handoffInput is single-shot and node-id-scoped: only apply it when it
      // targets THIS node, and clear it once inspected so it can never leak to a
      // later node or a subsequent turn.
      const allowCallerPrompt = node_params?.properties?.allowCallerPrompt === true;
      const pendingInput = sharedState.handoffInput;
      if (pendingInput && pendingInput.targetNodeId === node_params?.id) {
        sharedState.handoffInput = undefined; // consume on read
        if (allowCallerPrompt && pendingInput.prompt.trim()) {
          prepResult.inputText = pendingInput.prompt;
          log.info('Using caller-supplied prompt for isolated subflow', { nodeId: node_params?.id });
        } else {
          prepResult.inputText = promptTemplate ?? '';
        }
      } else {
        prepResult.inputText = promptTemplate ?? '';
      }
    } else {
      const sanitized = sanitizeForSubflow(sharedState.messages);
      prepResult.messages = inputMode === 'latest-message' ? latestUserMessage(sanitized) : sanitized;
    }

    // Tier 2c (named variables): inject `${var:NAME}` from the run-scoped
    // scratchpad into the subflow's isolated input — the "later enhancement" the
    // promptTemplate doc comment named. Only the isolated `inputText` is templated
    // (the history paths carry the verbatim transcript). When mapOverList splits
    // this text into items below, each item is already resolved.
    if (prepResult.inputText !== undefined) {
      // Tier 3: `${res:NAME}` named run resources resolve here too (after vars).
      prepResult.inputText = await resolveRunResourceRefs(
        resolveRunVars(prepResult.inputText, sharedState.variables),
        sharedState.ephemeral ? undefined : sharedState.conversationId,
        sharedState.emit,
        node_params?.id ? { nodeId: node_params.id, nodeType: 'subflow' } : undefined
      );
      // Tier 4 (persistent kv): `${kv:NAME}` cross-run values in the isolated
      // input. Scope keys off the PARENT flow (its folder), so a subflow node
      // shares a board with the parent flow's process nodes.
      if (prepResult.inputText.includes('${kv:')) {
        let folder: string | undefined;
        try {
          const { flowService } = await import('@/backend/services/flow/index');
          folder = (await flowService.getFlow(sharedState.flowId))?.folder;
        } catch { /* best effort */ }
        prepResult.inputText = await resolveKvNodeRefs(prepResult.inputText, { flowId: sharedState.flowId, folder });
      }
    }

    // Lane plan. The single decision point for both concurrency features: which
    // (if any) lanes prep resolves. The fan-out (issue #102) and map-over-list
    // (Tier 2a) branches both feed the SAME bounded pool / join / error strategy
    // downstream in execParallel; the ONLY difference is how lanes are built and
    // whether each lane carries its own input. Child-flow display names are
    // resolved best-effort for subflow:start attribution — never block on a lookup.
    if (mapOverList && parallelIds.length > 0) {
      // Defensive: the compiler and validator forbid combining the two modes.
      // If a hand-crafted node reaches here with both, keep the fan-out path
      // byte-for-byte and ignore mapOverList (matches the compiler's precedence).
      log.warn('SubflowNode sets both mapOverList and parallelSubflowIds; ignoring mapOverList (fan-out precedence)', {
        nodeId: node_params?.id,
      });
    }
    if (parallelIds.length > 0) {
      const lanes: SubflowLanePlan[] = parallelIds.map((id) => ({ subflowId: id }));
      try {
        const { flowService } = await import('@/backend/services/flow/index');
        await Promise.all(
          lanes.map(async (lane) => {
            try {
              const flow = await flowService.getFlow(lane.subflowId);
              if (flow?.name) lane.subflowName = flow.name;
            } catch {
              /* attribution only */
            }
          }),
        );
      } catch {
        /* attribution only */
      }
      prepResult.lanes = lanes;
      prepResult.concurrencyLimit = Math.max(1, node_params?.properties?.concurrencyLimit ?? 4);
      prepResult.joinSeparator = node_params?.properties?.joinSeparator ?? '\n\n';
      prepResult.errorStrategy = node_params?.properties?.errorStrategy ?? 'collect-all';
    } else if (mapOverList && subflowId) {
      // Map-over-list (Tier 2a): run the SINGLE child flow once per item parsed
      // from the resolved input. Isolated mode splits `inputText`; history modes
      // split the LAST user message (via latestUserMessage) so the item source is
      // a genuine instruction, not the whole transcript. Each item becomes its own
      // lane input, overriding the shared runInput in execParallel.
      const sourceText =
        prepResult.inputText !== undefined
          ? prepResult.inputText
          : messageText(latestUserMessage(prepResult.messages ?? [])[0]?.content);
      const items = splitItems(sourceText ?? '', itemSplit);
      let subflowName: string | undefined;
      try {
        const { flowService } = await import('@/backend/services/flow/index');
        const flow = await flowService.getFlow(subflowId);
        if (flow?.name) subflowName = flow.name;
      } catch {
        /* attribution only */
      }
      prepResult.lanes = items.map((item, i) => ({
        subflowId,
        subflowName,
        input: { prompt: item },
        itemIndex: i,
        itemCount: items.length,
      }));
      prepResult.mapOverList = true; // let execCore treat an EMPTY list as "nothing to map"
      // `sequential` pins the pool to 1 (in-order, one item at a time) rather than
      // adding a second execution path.
      prepResult.concurrencyLimit = sequential ? 1 : Math.max(1, node_params?.properties?.concurrencyLimit ?? 4);
      prepResult.joinSeparator = node_params?.properties?.joinSeparator ?? '\n\n';
      prepResult.errorStrategy = node_params?.properties?.errorStrategy ?? 'collect-all';
    } else if (subflowId) {
      try {
        const { flowService } = await import('@/backend/services/flow/index');
        const flow = await flowService.getFlow(subflowId);
        if (flow?.name) prepResult.subflowName = flow.name;
      } catch {
        /* attribution only — never block the run on a name lookup */
      }
    }

    log.info('prep() completed', {
      subflowId,
      depth: prepResult.depth,
      mode: inputMode,
      historyCount: prepResult.messages?.length,
      laneCount: prepResult.lanes?.length,
      showSteps,
    });
    return prepResult;
  }

  async execCore(prepResult: SubflowNodePrepResult, _node_params?: SubflowNodeParams): Promise<SubflowNodeExecResult> {
    // Lazy import breaks the static cycle:
    // SubflowNode -> runFlow -> FlowExecutor -> PocketflowEngine -> FlowConverter -> nodes
    const { runFlow } = await import('../runFlow');

    const nodeRef: NodeRef = {
      nodeId: prepResult.nodeId,
      nodeName: prepResult.nodeName,
      nodeType: 'subflow',
    };
    // prep sets exactly one of messages / inputText; the same input is fed to the
    // single child or fanned out to every parallel lane.
    const runInput: SubflowRunInput = prepResult.messages
      ? { messages: prepResult.messages }
      : { prompt: prepResult.inputText ?? '' };

    // Lane execution: fan-out/join (issue #102) OR map-over-list (Tier 2a). Both
    // resolve a lane plan in prep and run through the same bounded pool below.
    if (prepResult.lanes && prepResult.lanes.length > 0) {
      return this.execParallel(prepResult, runFlow, nodeRef, runInput);
    }

    // Map-over-list that resolved ZERO items: nothing to map. Fold a clean empty
    // result and hand off — never fall through and run the child once.
    if (prepResult.mapOverList) {
      log.info('execCore() map-over-list resolved no items → nothing to map', { subflowId: prepResult.subflowId });
      return { success: true, outputText: '', subStatus: 'completed', lanes: [] };
    }

    if (!prepResult.subflowId) {
      return { success: false, error: 'Subflow node has no flow selected (subflowId is empty).' };
    }

    // Single-child path (unchanged): fold the child run's events into the PARENT
    // conversation (outputMode 'steps', the default) with depth + 1, translating
    // run boundaries to subflow:start / subflow:done so a raw child run:done never
    // terminates the parent's SSE streams. Wrappers COMPOSE: a grandchild arrives
    // at depth 2.
    const childEmit = buildChildEmit(
      prepResult.emit,
      prepResult.showSteps,
      nodeRef,
      prepResult.subflowId,
      prepResult.subflowName,
    );

    log.info('execCore() running subflow', {
      subflowId: prepResult.subflowId,
      depth: prepResult.depth,
      showSteps: prepResult.showSteps,
      foldingEvents: !!childEmit,
    });
    const result = await runFlow({
      flowId: prepResult.subflowId,
      ...runInput,
      mode: 'ephemeral',
      flujo: true,
      requireApproval: false, // headless: subflows never pause for approval
      debug: false,
      depth: prepResult.depth,
      chainDepth: prepResult.chainDepth,
      parentRunId: prepResult.parentRunId,
      ...(childEmit ? { emit: childEmit } : {}),
    });

    if (result.status === 'error') {
      return {
        success: false,
        error: result.error?.message || 'Subflow execution failed',
        errorDetails: result.error?.details,
        subStatus: result.status,
      };
    }
    return { success: true, outputText: result.outputText, subStatus: result.status };
  }

  /**
   * Fan-out/join (issue #102): run each lane's child flow through a BOUNDED
   * worker pool (`concurrencyLimit`), each with a lane-scoped emit so interleaved
   * events stay separable, then collect results INDEXED BY CHILD ORDER (never
   * completion order) for a deterministic join. Siblings all run at the same
   * depth (`prepResult.depth`), so concurrency does not deepen the call tree and
   * grandchildren still hit runFlow's MAX_SUBFLOW_DEPTH guard normally. Error
   * handling follows `errorStrategy`; on success/partial the joined text is
   * returned so post() folds it and hands off exactly like the single-child path.
   */
  private async execParallel(
    prepResult: SubflowNodePrepResult,
    runFlow: RunFlowModule['runFlow'],
    nodeRef: NodeRef,
    runInput: SubflowRunInput,
  ): Promise<SubflowNodeExecResult> {
    const lanes = prepResult.lanes ?? [];
    const laneCount = lanes.length;
    const concurrencyLimit = Math.max(1, prepResult.concurrencyLimit ?? 4);
    const joinSeparator = prepResult.joinSeparator ?? '\n\n';
    const errorStrategy = prepResult.errorStrategy ?? 'collect-all';

    log.info('execCore() running parallel subflows', {
      laneCount,
      concurrencyLimit,
      errorStrategy,
      depth: prepResult.depth,
    });

    const results: (SubflowLaneResult | undefined)[] = new Array(laneCount);
    let cursor = 0;
    let aborted = false;

    const runLane = async (i: number): Promise<void> => {
      const lane = lanes[i];
      // Map-over-list lanes carry an explicit item index/count; fan-out lanes use
      // the plain lane position. Either way the live view separates concurrent
      // runs by laneIndex/laneCount, so per-item runs are separable like fan-out.
      const emit = buildChildEmit(
        prepResult.emit,
        prepResult.showSteps,
        nodeRef,
        lane.subflowId,
        lane.subflowName,
        { index: lane.itemIndex ?? i, count: lane.itemCount ?? laneCount },
      );
      try {
        // Map-over-list lanes carry their OWN input (one per item); fan-out lanes
        // have none, so they fall back to the shared runInput — keeping the fan-out
        // path byte-for-byte identical to before.
        const r = await runFlow({
          flowId: lane.subflowId,
          ...(lane.input ?? runInput),
          mode: 'ephemeral',
          flujo: true,
          requireApproval: false,
          debug: false,
          depth: prepResult.depth,
          chainDepth: prepResult.chainDepth,
          parentRunId: prepResult.parentRunId,
          ...(emit ? { emit } : {}),
        });
        results[i] =
          r.status === 'error'
            ? { subflowId: lane.subflowId, success: false, error: r.error?.message || 'Subflow execution failed' }
            : { subflowId: lane.subflowId, success: true, outputText: r.outputText };
      } catch (err) {
        results[i] = {
          subflowId: lane.subflowId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!results[i]!.success && errorStrategy === 'fail-fast') {
        aborted = true; // stop the pool from starting any further lanes
      }
    };

    // Cancellation guard for the pool (issue #109): once the parent run (or any
    // ancestor) is cancelled, workers stop pulling NEW lanes. In-flight lanes
    // terminate at their own runFlow cancellation guard (each child walks the
    // same ancestor chain).
    const { FlowExecutor } = await import('../FlowExecutor');
    const parentChainCancelled = (): boolean =>
      isCancelledByAncestry(prepResult.parentRunId, FlowExecutor.conversationStates);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted) return;
        if (parentChainCancelled()) {
          aborted = true;
          return;
        }
        const i = cursor++;
        if (i >= laneCount) return;
        await runLane(i);
      }
    };

    const poolSize = Math.min(concurrencyLimit, laneCount);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    // Filter preserves array index order => deterministic child-order join.
    const ordered = results.filter((r): r is SubflowLaneResult => r !== undefined);
    const succeeded = ordered.filter((r) => r.success);
    const failedLanes = ordered.filter((r) => !r.success);
    const anyFailed = failedLanes.length > 0;

    if (errorStrategy === 'fail-fast' && anyFailed) {
      const firstFailed = ordered.find((r) => !r.success);
      return {
        success: false,
        error: firstFailed?.error || 'A parallel subflow lane failed',
        subStatus: 'error',
        lanes: ordered,
      };
    }

    if (succeeded.length === 0) {
      return { success: false, error: 'All parallel subflows failed', subStatus: 'error', lanes: ordered };
    }

    let outputText = succeeded.map((r) => r.outputText ?? '').join(joinSeparator);
    if (anyFailed) {
      const summary = failedLanes.map((r) => `- ${r.subflowId}: ${r.error ?? 'unknown error'}`).join('\n');
      outputText += `${joinSeparator}[${failedLanes.length} parallel subflow(s) failed:\n${summary}]`;
    }

    return { success: true, outputText, subStatus: 'completed', lanes: ordered, partial: anyFailed };
  }

  async post(
    prepResult: SubflowNodePrepResult,
    execResult: SubflowNodeExecResult,
    sharedState: SharedState,
    node_params?: SubflowNodeParams,
  ): Promise<string> {
    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'SubflowNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Subflow Node',
        timestamp: new Date().toISOString(),
      });
    }

    if (!execResult.success) {
      log.error('Subflow failed', { subflowId: prepResult.subflowId, error: execResult.error });
      sharedState.lastResponse = {
        success: false,
        error: execResult.error || 'Subflow execution failed',
        errorDetails: execResult.errorDetails,
      };
      return ERROR_ACTION;
    }

    // Fold the subflow's output into the parent transcript as an assistant
    // message attributed to this node, and expose it as the latest response.
    const outputText = execResult.outputText ?? '';
    const assistantMessage: FlujoChatMessage = {
      role: 'assistant',
      content: outputText,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      processNodeId: node_params?.id,
    };
    sharedState.messages.push(assistantMessage);
    sharedState.lastResponse = outputText;

    // Tier 2c (named variables): capture the child's folded output into the
    // PARENT run's scratchpad so a later step can inject it via `${var:NAME}`.
    // This is the supported capture path — a var set inside the ephemeral child
    // run is discarded, so capture happens here on the parent's subflow node.
    const captureVariable = node_params?.properties?.captureVariable?.trim();
    if (captureVariable) {
      sharedState.variables = sharedState.variables ?? {};
      sharedState.variables[captureVariable] = outputText;
      log.info('Captured subflow output into run variable', { captureVariable, nodeId: node_params?.id });
    }

    // Tier 3: also store the folded output as a NAMED run-scoped resource on
    // the PARENT run (like captureVariable above — the ephemeral child's store
    // writes are disabled, so this is the supported capture path).
    const captureResource = node_params?.properties?.captureResource?.trim();
    if (captureResource && sharedState.conversationId && !sharedState.ephemeral) {
      try {
        const written = await writeRunResource({
          conversationId: sharedState.conversationId,
          name: captureResource,
          mimeType: 'text/markdown',
          kind: 'text',
          data: { text: outputText },
          producedBy: {
            source: 'capture',
            nodeId: node_params?.id,
            nodeName: node_params?.properties?.name,
          },
        });
        if ('skipped' in written) {
          log.warn('captureResource skipped by store cap', { captureResource, reason: written.skipped });
        } else {
          sharedState.emit?.({
            type: 'resource:write',
            node: { nodeId: node_params?.id ?? 'unknown', nodeName: node_params?.properties?.name, nodeType: 'subflow' },
            server: 'flujo',
            uri: written.uri,
            name: captureResource,
            mimeType: written.mimeType,
            size: written.size,
            source: 'capture',
          });
          log.info('Captured subflow output into run resource', { captureResource, uri: written.uri, nodeId: node_params?.id });
        }
      } catch (error) {
        log.error('captureResource failed; continuing run', error);
      }
    }

    // Tier 4 (persistent kv): also save the folded output to a PERSISTENT
    // cross-run key with `captureKv: "NAME"` (scope-prefixable). Survives across
    // runs, unlike captureVariable/captureResource. Scope keys off the parent flow.
    const captureKv = node_params?.properties?.captureKv?.trim();
    if (captureKv) {
      try {
        let folder: string | undefined;
        try {
          const { flowService } = await import('@/backend/services/flow/index');
          folder = (await flowService.getFlow(sharedState.flowId))?.folder;
        } catch { /* best effort */ }
        const res = await captureKvValue(captureKv, outputText, { flowId: sharedState.flowId, folder });
        if ('skipped' in res) {
          log.warn('captureKv skipped', { captureKv, reason: res.skipped });
        } else {
          log.info('Captured subflow output into persistent kv', { captureKv, nodeId: node_params?.id });
        }
      } catch (error) {
        log.error('captureKv failed; continuing run', error);
      }
    }

    // Hand off to the single linear successor, else end the flow.
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    if (actions.length > 0) {
      const action = actions[0];
      log.info(`post() completed, handing off via action: ${action}`);
      return action;
    }
    log.info('post() completed, no successor → FINAL_RESPONSE_ACTION');
    return FINAL_RESPONSE_ACTION;
  }

  _clone(): BaseNode {
    return new SubflowNode();
  }
}
