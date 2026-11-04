// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { SharedState, StaticEntry, StaticNodeParams, ERROR_ACTION, ErrorDetails, FINAL_RESPONSE_ACTION, HUMAN_APPROVAL_ACTION } from '../types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { FlujoFunctionToolCall } from '@/shared/types/openai';
import { resolveRunVars, isValidRunVarName } from '@/utils/shared/resolveRunVars';
import { boundStaticText, staticResultJson, staticResultText, MAX_STATIC_ERROR_CHARS } from '@/utils/shared/staticToolResult';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { FEATURES } from '@/config/features';
import { mcpService } from '@/backend/services/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import type { MCPServiceResponse } from '@/shared/types/mcp';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { applyPresetArguments, resolvePromptDynamicReferences } from '@/backend/utils/resolveDynamicReferences';
import { mergeToolParameterPresets } from '@/utils/shared/toolParameterPresets';
import { redactErrorDetails } from '../normalizeError';
import { combineAbortSignals } from '../combineAbortSignals';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { defaultConditionTarget, selectConditionedEdge } from '@/utils/shared/edgeConditions';
import { HUMAN_GATE_APPROVED_RESULT, HUMAN_GATE_REJECTED_RESULT, HUMAN_GATE_TOOL_NAME } from '@/utils/shared/flowApproval';
import {
  PERSONA_MEMORY_GATEWAY_SERVER,
  executePersonaMemoryMaintenanceCommit,
} from '../handlers/personaMemoryGateway';

const log = createLogger('backend/flow/execution/nodes/StaticNode');

/**
 * A real call follows the same approval rules as a call a model makes: the run's own
 * setting, the node's rule and the entry's flag. FLUJO's internal memory commit is not
 * a connected tool and has its own authority, so it is not asked about. A server that
 * cannot say a tool is read-only is treated as if it could change data.
 */
async function callNeedsPerson(
  entry: { requireApproval?: boolean },
  toolName: string,
  serverName: string,
  sharedState: SharedState,
  node_params: StaticNodeParams | undefined,
): Promise<boolean> {
  if (serverName === PERSONA_MEMORY_GATEWAY_SERVER) return false;
  const properties = node_params?.properties;
  if (entry.requireApproval === true || sharedState.requireApproval === true
    || properties?.requireApprovalFor?.includes(toolName)) return true;
  if (properties?.requireApprovalForWrites !== true) return false;
  try {
    const listed = await mcpService.listServerTools(serverName);
    return listed.tools?.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint !== true;
  } catch (error) {
    log.warn('Could not read tool hints; asking a person to be safe', { serverName, toolName, error });
    return true;
  }
}

async function deliverResult(call: () => Promise<MCPServiceResponse>): Promise<MCPServiceResponse> {
  try {
    return await call();
  } catch (cause) {
    return { success: false, errorType: 'transport', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Static node (issue #358) — a non-LLM, pass-through node that
 * INJECTS pre-authored entries into the conversation when execution traverses
 * it, then hands off to its first successor unchanged.
 *
 * Unlike the SignalNode (which is deliberately transparent and must never touch
 * the conversation), the whole point of this node is to mutate
 * `sharedState.messages`, mechanically the way `StartNode.post` injects its
 * system message. Use it for few-shot scaffolding, canned instructions, or
 * pre-seeded tool-call/result pairs.
 *
 * Entry kinds:
 *  - `message`  → one message with the authored role/content.
 *  - `toolCall` → executes the connected MCP tool when `executionMode` is
 *    `real`, or uses the authored deterministic result for `mock`/legacy
 *    entries. It then appends a paired assistant tool-call and tool-result
 *    message. Well-formed pairing is mandatory, otherwise provider adapters
 *    reject the history — invalid `argumentsJson` therefore fails loudly. With
 *    `requireApproval`, a person decides on the call before it runs.
 *  - `humanGate` → the run waits for a person's decision, with no tool involved.
 *
 * Text fields support run variables/resources and dynamic @ references.
 * Real calls apply the connected server/node's hidden presets at dispatch.
 *
 * Re-entry (issue #381): by default the node appends on every traversal; with
 * `injectOnce: true` it injects only once per **logical run**. The dedupe key is
 * `(sharedState.logicalRunId, nodeId)`, stored in `sharedState.staticInjected`, so
 * an approval/debug resume of the same run does not re-inject while a new user turn
 * (new logical run) does. Subflow runs carry their own SharedState and therefore
 * their own markers. See docs/features/flows/static-node.md#re-entry-semantics.
 */
export class StaticNode extends BaseNode<
  StaticNodeParams,
  SharedState,
  { entries: StaticEntry[]; injectOnce: boolean },
  Record<string, never>
> {
  async prep(
    _sharedState: SharedState,
    node_params?: StaticNodeParams
  ): Promise<{ entries: StaticEntry[]; injectOnce: boolean }> {
    const entries = Array.isArray(node_params?.properties?.entries)
      ? (node_params!.properties!.entries as StaticEntry[])
      : [];
    const injectOnce = node_params?.properties?.injectOnce === true;
    log.info('prep() started', { nodeId: node_params?.id, entryCount: entries.length, injectOnce });
    return { entries, injectOnce };
  }

  async execCore(): Promise<Record<string, never>> {
    // No work: the injection happens in post(), where run context is in scope.
    return {};
  }

  async post(
    prepResult: { entries: StaticEntry[]; injectOnce: boolean },
    _execResult: unknown,
    sharedState: SharedState,
    node_params?: StaticNodeParams
  ): Promise<string> {
    const nodeId = node_params?.id || 'unknown';
    log.info('post() started', { nodeId, entryCount: prepResult.entries.length });

    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'StaticNode',
        nodeId,
        nodeName: node_params?.properties?.name || 'Static',
        timestamp: new Date().toISOString(),
      });
    }

    // "Once" means once per logical run (one user turn), not once per conversation:
    // the marker stores the run that injected, so a persisted map from an earlier turn
    // can never suppress this run's injection.
    const runId = sharedState.logicalRunId ?? 'no-run';
    const alreadyInjected = sharedState.staticInjected?.[nodeId] === runId;
    // A person's decision resumes this node at the entry that waited for it. A hold
    // with no decision asks again rather than assuming. This cannot compare run ids:
    // resuming after a decision starts a new logical run. A new user turn clears it.
    const decided = sharedState.staticHold?.nodeId === nodeId && sharedState.staticHold.decision
      ? sharedState.staticHold
      : undefined;
    sharedState.staticHold = undefined;
    const referenceContext = {
      conversationId: sharedState.conversationId,
      flowId: sharedState.flowId,
      nodeId,
    };
    const resolveRunText = async (value: string): Promise<string> =>
      sharedState.executionExtensionContext ? (value ?? '') : resolveRunResourceRefs(
        resolveRunVars(value ?? '', sharedState.variables),
        sharedState.ephemeral ? undefined : sharedState.conversationId,
        sharedState.emit,
        { nodeId },
        sharedState,
      );
    const resolve = async (value: string): Promise<string> => {
      const text = await resolveRunText(value);
      return sharedState.executionExtensionContext ? text : String(await resolvePromptDynamicReferences(text, referenceContext));
    };

    if (prepResult.injectOnce && alreadyInjected && !decided) {
      log.info('injectOnce: skipping repeat injection', { nodeId });
    } else if (prepResult.entries.length > 0) {
      if (!Array.isArray(sharedState.messages)) {
        sharedState.messages = [];
      }

      const messages: FlujoChatMessage[] = [];
      const holdForPerson = (
        entryIndex: number,
        toolCall: FlujoFunctionToolCall,
        mcpCall?: { serverName: string; toolName: string },
      ): string => {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
          ...(mcpCall ? { mcpToolCalls: { [toolCall.id]: mcpCall } } : {}),
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        } as FlujoChatMessage);
        sharedState.messages.push(...messages);
        sharedState.staticHold = {
          nodeId, entryIndex, toolCallId: toolCall.id, argumentsJson: toolCall.function.arguments,
        };
        sharedState.pendingToolCalls = [toolCall];
        log.info('Waiting for a person', { nodeId, entryIndex });
        return HUMAN_APPROVAL_ACTION;
      };
      const answerHold = (toolCallId: string, content: string) => messages.push({
        role: 'tool', tool_call_id: toolCallId, content, id: crypto.randomUUID(), timestamp: Date.now(),
      } as FlujoChatMessage);
      const stopAfterRejection = async (rejectedText: string | undefined): Promise<string> => {
        const output = boundStaticText(await resolve(rejectedText ?? 'Not approved.'));
        messages.push({ role: 'assistant', content: output, id: crypto.randomUUID(), timestamp: Date.now() } as FlujoChatMessage);
        sharedState.messages.push(...messages);
        sharedState.lastResponse = output;
        return FINAL_RESPONSE_ACTION;
      };
      const validateRejectOptions = (entry: { onReject?: unknown }) => {
        if (entry.onReject !== undefined && entry.onReject !== 'stop' && entry.onReject !== 'continue') {
          throw new Error(`Static node ${nodeId}: onReject must be stop or continue.`);
        }
      };

      for (let entryIndex = decided?.entryIndex ?? 0; entryIndex < prepResult.entries.length; entryIndex++) {
        const entry = prepResult.entries[entryIndex];
        const heldHere = decided?.entryIndex === entryIndex ? decided : undefined;

        if (entry.kind === 'humanGate') {
          validateRejectOptions(entry);
          // An evaluation has nobody to ask, and nothing it does has a real effect.
          if (getHarnessExecution()) continue;
          if (!heldHere) {
            const text = (await resolve(entry.text ?? '')).trim();
            if (!text) throw new Error(`Static node ${nodeId}: a human gate entry requires text.`);
            return holdForPerson(entryIndex, {
              id: `call_static_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
              type: 'function',
              function: { name: HUMAN_GATE_TOOL_NAME, arguments: JSON.stringify({ text }) },
            });
          }
          const approved = heldHere.decision === 'approved';
          answerHold(heldHere.toolCallId, approved ? HUMAN_GATE_APPROVED_RESULT : HUMAN_GATE_REJECTED_RESULT);
          if (!approved && (entry.onReject ?? 'stop') === 'stop') return stopAfterRejection(entry.rejectedText);
          continue;
        }

        if (entry.kind === 'message') {
          let content = await resolve(entry.content);
          const media: ModelMediaPart[] = [];
          for (const attachment of entry.attachments ?? []) {
            if (
              attachment.type === 'document'
              && typeof attachment.content === 'string'
              && !attachment.content.startsWith('data:')
            ) {
              const documentText = await resolve(attachment.content);
              content += `${content ? '\n\n' : ''}[DOCUMENT${attachment.originalName ? `: ${attachment.originalName}` : ''}]\n${documentText}`;
              continue;
            }

            const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(attachment.content ?? '');
            if (!match) continue;
            media.push({
              type: attachment.type === 'document' ? 'file' : attachment.type,
              mimeType: attachment.mimeType || match[1],
              data: match[2],
              name: attachment.originalName,
              transcript: attachment.transcript,
            });
          }
          messages.push({
            role: entry.role,
            content,
            ...(media.length > 0 ? { media } : {}),
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          continue;
        }

        if (entry.kind === 'toolCall') {
          const toolName = (entry.toolName ?? '').trim();
          if (!toolName) {
            throw new Error(`Static node ${nodeId}: a tool-call entry requires a tool name.`);
          }
          validateRejectOptions(entry);
          if (entry.requireApproval === true && entry.executionMode !== 'real') {
            throw new Error(`Static node ${nodeId}: requireApproval requires a real tool call.`);
          }
          // After a decision, run exactly what the person saw, not a fresh rendering.
          let argumentsJson = heldHere?.argumentsJson
            ?? ((await resolveRunText(entry.argumentsJson ?? '')).trim() || '{}');
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(argumentsJson) as Record<string, unknown>;
          } catch {
            throw new Error(
              `Static node ${nodeId}: tool-call entry for "${toolName}" has invalid JSON arguments.`
            );
          }
          if (!sharedState.executionExtensionContext && !heldHere) {
            // Resolve JSON values after parsing so quotes and nested structures
            // remain valid; hidden preset values are added only at dispatch.
            const resolvedArgs = await resolvePromptDynamicReferences(args, {
              ...referenceContext, appId: (entry.serverName ?? '').trim() || undefined,
            }) as Record<string, unknown>;
            if (JSON.stringify(resolvedArgs) !== JSON.stringify(args)) argumentsJson = JSON.stringify(resolvedArgs);
            args = resolvedArgs;
          }

          const toolCallId = heldHere?.toolCallId ?? `call_static_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
          const toolCall: FlujoFunctionToolCall = {
            id: toolCallId,
            type: 'function',
            function: { name: toolName, arguments: argumentsJson },
          };

          const executionMode = entry.executionMode === 'real' ? 'real' : 'mock';
          const serverName = (entry.serverName ?? '').trim();
          const captureVariable = entry.captureVariable?.trim();
          if (captureVariable && !isValidRunVarName(captureVariable)) {
            throw new Error(`Static node ${nodeId}: invalid capture variable "${captureVariable}".`);
          }
          if (entry.onError !== undefined && entry.onError !== 'continue' && entry.onError !== 'fail') {
            throw new Error(`Static node ${nodeId}: onError must be continue or fail.`);
          }
          if (entry.onError === 'fail' && executionMode !== 'real') {
            throw new Error(`Static node ${nodeId}: fail policy requires a real tool call.`);
          }
          if (entry.resultFormat !== undefined && entry.resultFormat !== 'text' && entry.resultFormat !== 'json') {
            throw new Error(`Static node ${nodeId}: resultFormat must be text or json.`);
          }
          if (heldHere || (executionMode === 'real' && !getHarnessExecution()
            && await callNeedsPerson(entry, toolName, serverName, sharedState, node_params))) {
            if (!heldHere) {
              return holdForPerson(entryIndex, toolCall, serverName ? { serverName, toolName } : undefined);
            }
            if (heldHere.decision !== 'approved') {
              answerHold(toolCallId, HUMAN_GATE_REJECTED_RESULT);
              if ((entry.onReject ?? 'stop') === 'stop') return stopAfterRejection(entry.rejectedText);
              continue;
            }
          }

          let resultContent = executionMode === 'mock' ? await resolve(entry.result ?? '') : '';
          let resultValue: unknown = resultContent;
          let resultDelivered = false;
          let failure: ErrorDetails | undefined;

          if (executionMode === 'real') {
            if (sharedState.isCancelled || sharedState.abortSignal?.aborted) {
              sharedState.messages.push(...messages);
              sharedState.lastResponse = { success: false, error: 'Execution cancelled.', errorDetails: {
                message: 'Execution cancelled.', type: 'mcp_service_error', code: 'static_tool_cancelled',
              } };
              return ERROR_ACTION;
            }
            if (!serverName) {
              throw new Error(`Static node ${nodeId}: real tool call "${toolName}" requires an MCP server.`);
            }
            const callResult = serverName === PERSONA_MEMORY_GATEWAY_SERVER
              ? await deliverResult(() => executePersonaMemoryMaintenanceCommit(toolName, args, {
                  variables: sharedState.variables,
                  conversationId: sharedState.conversationId,
                  executionAuthority: sharedState.executionAuthority,
                  personaAttribution: sharedState.personaAttribution,
                }))
              : await (async () => {
                  const binding = node_params?.properties?.mcpNodes?.find(
                    (candidate) => candidate.properties?.boundServer === serverName,
                  );
                  if (!binding || !binding.properties.enabledTools?.includes(toolName)) {
                    throw new Error(
                      `Static node ${nodeId}: real tool call "${toolName}" is not enabled on its connected MCP server "${serverName}".`,
                    );
                  }
                  // Register the connected MCP node's roots before dispatch, matching
                  // Process-node tool preparation. This makes both roots/list and the
                  // built-in filesystem/bash confinement see the authored overlay even
                  // when a Static node is the first consumer to touch the server.
                  mcpService.setNodeRoots(serverName, binding.id, binding.properties.roots);
                  const serverConfigs = await mcpService.loadServerConfigs();
                  if (!Array.isArray(serverConfigs)) {
                    throw new Error(`Static node ${nodeId}: could not load MCP parameter presets for "${serverName}".`);
                  }
                  const serverConfig = serverConfigs.find(config => config.name === serverName);
                  const effectiveArgs = await applyPresetArguments(args, mergeToolParameterPresets(
                    serverConfig?.toolParameterPresets,
                    binding.properties.toolParameterPresets,
                    toolName,
                  ), { ...referenceContext, appId: serverName });
                  const callArguments = [
                    serverName,
                    toolName,
                    effectiveArgs,
                    binding.properties.toolTimeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
                    undefined,
                    binding.id,
                  ] as const;
                  const extensionContext = sharedState.executionExtensionContext;
                  return extensionContext
                    ? deliverResult(async () => mcpService.callTool(...callArguments,
                        combineAbortSignals(sharedState.abortSignal,
                          (await import('@/backend/execution/extensions')).executionExtensionSignal(extensionContext)),
                        'host', undefined, undefined, extensionContext))
                    : deliverResult(() => sharedState.abortSignal
                      ? mcpService.callTool(...callArguments, sharedState.abortSignal)
                      : mcpService.callTool(...callArguments));
                })();
            resultValue = callResult.success ? callResult.data ?? null : { success: false, error: callResult.error, errorType: callResult.errorType };
            resultDelivered = callResult.success;
            resultContent = callResult.success
              ? JSON.stringify(callResult.data ?? null)
              : `Error: ${callResult.error || `Tool ${toolName} failed`}`;
            // MCP delivery success is distinct from a tool-level isError flag.
            // Never infer failure from exitCode, stderr or arbitrary application JSON.
            const toolError = callResult.success && !!callResult.data && typeof callResult.data === 'object'
              && (callResult.data as Record<string, unknown>).isError === true;
            const cancelled = sharedState.isCancelled || sharedState.abortSignal?.aborted;
            if (((!callResult.success || toolError) && entry.onError === 'fail') || cancelled) {
              const code = cancelled ? 'static_tool_cancelled' : toolError ? 'static_mcp_tool_error'
                : callResult.errorType === 'timeout' ? 'static_mcp_timeout'
                : callResult.errorType === 'cancelled' ? 'static_tool_cancelled' : 'static_mcp_service_error';
              const reason = cancelled ? 'Execution cancelled.'
                : toolError ? staticResultText(callResult.data) || 'MCP tool returned isError: true'
                : callResult.error || 'MCP service failed';
              const message = boundStaticText(`Static ${serverName}/${toolName}: ${reason}`, MAX_STATIC_ERROR_CHARS);
              failure = {
                message: boundStaticText(String(redactErrorDetails({ message })?.message ?? 'Static MCP call failed.'), MAX_STATIC_ERROR_CHARS),
                type: !cancelled && toolError ? 'mcp_tool_error' : 'mcp_service_error',
                code,
                name: boundStaticText(toolName, 200),
                param: boundStaticText(serverName, 200),
                status: callResult.statusCode,
              };
            }
          }

          if (captureVariable) {
            // Mock JSON captures preserve authored JSON when parseable; ordinary
            // mock text becomes a JSON string. The injected mock remains unchanged.
            if (executionMode === 'mock' && entry.resultFormat === 'json') {
              try { resultValue = JSON.parse(resultContent); } catch { resultValue = resultContent; }
            }
            sharedState.variables ??= {};
            const captured = entry.resultFormat === 'json'
              ? staticResultJson(resultValue)
              : executionMode === 'mock' || !resultDelivered ? boundStaticText(resultContent) : staticResultText(resultValue);
            Object.defineProperty(sharedState.variables, captureVariable, {
              value: captured, configurable: true, enumerable: true, writable: true,
            });
          }

          // After a decision, the call is already in the conversation from the wait.
          if (!heldHere) {
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: [toolCall],
              ...(serverName ? {
                mcpToolCalls: { [toolCallId]: { serverName, toolName } },
              } : {}),
              id: crypto.randomUUID(),
              timestamp: Date.now(),
            } as FlujoChatMessage);
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: resultContent,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          if (failure) {
            sharedState.messages.push(...messages);
            sharedState.lastResponse = { success: false, error: failure.message, errorDetails: failure };
            return ERROR_ACTION;
          }
          continue;
        }

        throw new Error(`Static node ${nodeId}: unknown entry kind.`);
      }

      sharedState.messages.push(...messages);
      // Drop markers left by earlier logical runs while writing this one, so the map
      // cannot grow unbounded over a long conversation.
      const markers = new Map<string, string>();
      for (const [id, marker] of Object.entries(sharedState.staticInjected ?? {})) {
        if (marker === runId) markers.set(id, marker);
      }
      markers.set(nodeId, runId);
      sharedState.staticInjected = Object.fromEntries(markers);
      log.info('Injected static messages', { nodeId, messageCount: messages.length });
    }

    if (typeof node_params?.properties?.outputTemplate === 'string') {
      // Captured tool data is literal output, never another template. Resolve
      // authored resource/dynamic references before inserting run variables.
      const authored = node_params.properties.outputTemplate;
      const resourceText = sharedState.executionExtensionContext ? authored : await resolveRunResourceRefs(
        authored, sharedState.ephemeral ? undefined : sharedState.conversationId,
        sharedState.emit, { nodeId }, sharedState,
      );
      const referenceText = sharedState.executionExtensionContext ? resourceText
        : String(await resolvePromptDynamicReferences(resourceText, referenceContext));
      const output = boundStaticText(resolveRunVars(referenceText, sharedState.variables));
      sharedState.lastResponse = output;
      sharedState.messages.push({ role: 'assistant', content: output, id: crypto.randomUUID(), timestamp: Date.now() } as FlujoChatMessage);
    }

    // Conditions see this node's own result, because they run after its entries.
    const edgeConditions = node_params?.edgeConditions;
    if (edgeConditions && Object.keys(edgeConditions).length > 0) {
      const routed = selectConditionedEdge(
        node_params?.orderedOutgoingEdges ?? Array.from(this.successors.keys()),
        edgeConditions,
        sharedState.messages,
        defaultConditionTarget('static'),
        sharedState.variables,
      );
      log.info('Static node routing by edge condition', { nodeId, edgeId: routed });
      return routed ?? FINAL_RESPONSE_ACTION;
    }

    // Pass through to the first successor.
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    return actions.length > 0 ? actions[0] : 'default';
  }

  _clone(): BaseNode {
    return new StaticNode();
  }
}
