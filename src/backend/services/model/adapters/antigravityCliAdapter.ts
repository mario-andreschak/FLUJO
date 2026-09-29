import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { rethrowFlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { mcpService } from '@/backend/services/mcp';
import { ownerScopeForRun } from '@/backend/services/mcp/ownerScope';
import { getRunResourceSettings } from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { splitToolResultMedia } from '@/backend/services/runResources/toolResultMedia';
import {
  resolveInvokedToolUiLink,
  toolCancellationReason,
} from '@/backend/mcpApps/toolUi';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { FlujoChatMessage } from '@/shared/types/chat';
import { CompletionAdapter, CompletionInput, CompletionResult, observeSdkRequest, type SteeringDelivery } from './types';
import { steeringSource, watchSteering } from './liveSteering';
import { normalizeMessageInput } from './messageNormalization';
import { startCodexToolBridge, BridgeTool } from './codexToolBridge';
import { paceToolCallArguments } from './toolArgumentPacing';
import { extractMediaParts, extractNativeMediaParts } from './messageUtils';
import { classifyStatisticsError, createStatisticsEvent, recordStatisticsEvent } from '@/backend/services/statistics';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';
import { prepareAntigravityCliRuntime, ANTIGRAVITY_CLI_TIMEOUT_MS, type AntigravityCliRuntime } from './antigravityCliRuntime';
import { runAntigravityCli, antigravityCliAbortError, prepareAntigravityCliPrompt, antigravityCliFailureHint } from './antigravityCliProcess';
import { mapAntigravityCliUsage, type AntigravityCliEvent } from './antigravityCliEvents';

const log = createLogger('backend/services/model/adapters/antigravityCliAdapter');
const MAX_TOOL_NAME_LEN = 110;
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildReadableName(server: string, tool: string, used: Set<string>): string {
  let base = `${sanitizeName(server)}__${sanitizeName(tool)}`;
  if (base.length > MAX_TOOL_NAME_LEN) base = base.slice(0, MAX_TOOL_NAME_LEN);
  let name = base;
  let i = 2;
  while (used.has(name)) {
    const suffix = `_${i++}`;
    name = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

function isHandoffName(name: string): boolean {
  return name.startsWith('handoff_to_') || name === 'handoff';
}

function antigravityBridgeResult(result: CallToolResult): CallToolResult {
  // Preserve JSON primitive/array/null results for MCP clients that promote
  // text to structuredContent, which must be a record. Content stays unchanged.
  if (result.structuredContent || result.content[0]?.type !== 'text') return result;
  try {
    const parsed: unknown = JSON.parse(result.content[0].text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return result;
    return { ...result, structuredContent: { result: parsed } };
  } catch {
    return result;
  }
}

interface ToolInteraction {
  id: string;
  name: string;
  argsJson: string;
  resultContent: string;
  ui?: ToolUi;
}

type ToolUi = NonNullable<FlujoChatMessage['ui']>;
type TranscriptMessage = OpenAI.ChatCompletionMessageParam & {
  ui?: ToolUi;
  media?: import('@/shared/types/model/media').ModelMediaPart[];
};

/** Official Antigravity CLI owns the model loop; FLUJO owns every exposed tool. */
export class AntigravityCliAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    const {
      model,
      apiKey,
      messages,
      tools,
      toolNameMap,
      localToolExecutors,
      shouldEndAgenticTurn,
      requestToolApproval,
      onTranscriptMessage,
      onModelDelta,
      onToolProgress,
      signal,
      beforeToolDispatch,
      authorizePersonaCoreMcp,
      afterToolDispatch,
      commitDurableMutation,
      conversationId,
      runId,
      nodeId,
      runResourceMarkers,
    } = input;
    const fullInput = normalizeMessageInput(messages, runResourceMarkers);
    const attachments = messages.flatMap(message => message.role === 'user' ? extractMediaParts(message.content) : []);
    if (fullInput.images.length || attachments.length || messages.some(message => extractNativeMediaParts(message.content).length > 0)) {
      throw new Error('Antigravity CLI connections currently support text input only. Use a native Gemini connection for image, document, audio, or video attachments.');
    }

    const abortController = new AbortController();
    const maxTurns = Number.isFinite(input.maxTurns) && (input.maxTurns ?? 0) > 0
      ? Math.floor(input.maxTurns!) : DEFAULT_AGENTIC_MAX_TURNS;
    const deadlineAt = Date.now() + ANTIGRAVITY_CLI_TIMEOUT_MS;
    let bridgeDispatches = 0;
    const seenSteps = new Set<string>();
    let endedByCaller = false;
    let activeChild: AbortController | undefined;
    let fatalError: unknown;
    const endedToolResult = (): CallToolResult => ({
      content: [{ type: 'text', text: 'This agentic turn has ended; no further tools may run.' }],
      isError: true,
    });
    const onExternalAbort = () => { abortController.abort(); activeChild?.abort(); };
    if (signal?.aborted) {
      abortController.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Transcript recording — identical contract to the Claude adapter: stable
    // ids, streamed live as produced, returned for persistence.
    const transcript: FlujoChatMessage[] = [];
    const unansweredTools = new Set<string>();
    const baseTs = Date.now();
    let txSeq = 0;
    // Every invocation has unique ids; streamed drafts and durable transcript
    // entries reuse the same id so React reconciles them without duplication.
    const streamMessageNamespace = `${baseTs}_${uuidv4()}`;
    const getStreamMessageId = (itemId: string): string =>
      `stream_antigravity_cli_${streamMessageNamespace}_${itemId}`;
    const recordMessage = (msg: TranscriptMessage, id = `m_${uuidv4()}`): void => {
      const full = { ...msg, id, timestamp: baseTs + txSeq++ } as FlujoChatMessage;
      transcript.push(full);
      onTranscriptMessage?.(full);
    };
    const recordSteeringMessage = (message: FlujoChatMessage): void => {
      // Preserve the id chosen by the inject route so the durable/live copy
      // reconciles the optimistic user bubble.
      transcript.push(message);
      onTranscriptMessage?.(message);
    };
    const recordToolCall = (
      ti: Pick<ToolInteraction, 'id' | 'name' | 'argsJson'>,
      messageId?: string,
    ): void => {
      unansweredTools.add(ti.id);
      recordMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      }, messageId);
    };
    // The MCP bridge receives complete arguments. Project paced name-first
    // deltas under the SAME message
    // id the durable transcript message will use. The streamed draft therefore
    // fills in visibly and is then reconciled (not duplicated) by the durable
    // message. Presentation only — approval and execution keep using `argsJson`.
    const streamToolCall = async (
      ti: Pick<ToolInteraction, 'id' | 'name' | 'argsJson'>,
    ): Promise<void> => {
      // Reserve the tool boundary before paced argument projection yields.
      unansweredTools.add(ti.id);
      const messageId = getStreamMessageId(`toolcall_${ti.id}`);
      await paceToolCallArguments({
        messageId,
        callId: ti.id,
        name: ti.name,
        argsJson: ti.argsJson,
        onModelDelta,
      });
      recordToolCall(ti, messageId);
    };
    const recordToolResult = (ti: Pick<ToolInteraction, 'id' | 'resultContent' | 'ui'>): void => {
      if (!unansweredTools.has(ti.id)) return;
      recordMessage({
        role: 'tool',
        tool_call_id: ti.id,
        content: ti.resultContent,
        ...(ti.ui ? { ui: ti.ui } : {}),
      });
      unansweredTools.delete(ti.id);
    };
    // Spawn-with-brief bookkeeping (issue #156), mirroring the Claude adapter.
    const handoffCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let endSpawning = false;

    // Approval gate, applied inside every bridge handler before dispatch. The
    // caller has already recorded the assistant(tool_call), so a pending card is
    // visible while approval is open. On rejection only the terminal tool result
    // is appended here (the tool never runs).
    const gate = async (
      callId: string,
      name: string,
      args: Record<string, unknown>,
      resolveRejectedUi?: (reason: string) => Promise<ToolUi | undefined>,
    ): Promise<CallToolResult | null> => {
      if (!requestToolApproval) return null;
      const approved = await requestToolApproval({ id: callId, name, args });
      if (approved && !abortController.signal.aborted && !shouldEndAgenticTurn?.()) return null;
      const rejectionText = 'tool denied';
      const ui = await resolveRejectedUi?.(rejectionText);
      recordToolResult({
        id: callId,
        resultContent: rejectionText,
        ...(ui ? { ui } : {}),
      });
      return { content: [{ type: 'text', text: rejectionText }], isError: true };
    };

    // Build the bridge tools from the node's bound tools. MCP tools dispatch to
    // mcpService; handoff tools record the handoff; caller-defined local tools
    // dispatch to their executor. Anything else is omitted from an agentic run.
    const usedNames = new Set((tools ?? []).filter(tool => isHandoffName(tool.function.name) || localToolExecutors?.[tool.function.name]).map(tool => tool.function.name));
    const unguardedBridgeTools: BridgeTool[] = (tools ?? [])
      .filter(t => t.type === 'function')
      .map((t): BridgeTool | null => {
        const fnName = t.function.name;
        const handoff = isHandoffName(fnName);
        const decoded = toolNameMap?.[fnName];
        const localExec = localToolExecutors?.[fnName];
        if (!handoff && !decoded && !localExec) return null;
        const inputSchema = t.function.parameters as Record<string, unknown> | undefined;
        const description = t.function.description ?? '';

        if (handoff) {
          const spawnable = !!(inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.task;
          return {
            name: fnName, // exact name so FLUJO's handoff_to_<nodeId> routing matches
            description,
            inputSchema,
            handler: async (args) => {
              if (abortController.signal.aborted || shouldEndAgenticTurn?.()) return endedToolResult();
              if (requestToolApproval && !await requestToolApproval({ id: `call_${uuidv4()}`, name: fnName, args: args ?? {} })) {
                return { content: [{ type: 'text', text: 'tool denied' }], isError: true };
              }
              await checkToolFence();
              const toolStartedAt = Date.now();
              if (handoffCalls.length >= 32) return { content: [{ type: 'text', text: 'Maximum parallel handoffs reached.' }], isError: true };
              handoffCalls.push({ name: fnName, args: args ?? {} });
              if (runId) {
                recordStatisticsEvent(createStatisticsEvent({
                  type: 'tool.invocation',
                  runId,
                  node: nodeId ? { id: nodeId } : undefined,
                  tool: { id: fnName, name: fnName, kind: 'handoff' },
                  outcome: 'completed',
                  durationMs: Math.max(0, Date.now() - toolStartedAt),
                }));
              }
              log.debug('Antigravity CLI requested handoff', { tool: fnName, callIndex: handoffCalls.length, spawnable });
              // Do NOT abort here — return cleanly so the CLI's tool round-trip
              // completes; the event loop ends the run at the next streamed
              // event (plain handoff) or when the model stops calling (spawn).
              if (!spawnable) {
                endSpawning = true;
                return { content: [{ type: 'text', text: 'Handing off.' }] };
              }
              return {
                content: [{
                  type: 'text',
                  text: 'Worker spawned for this task. Call this tool again right now to spawn another parallel worker (one call per task). When you stop calling it, all spawned workers run concurrently and their merged results come back.',
                }],
              };
            },
          };
        }

        if (localExec) {
          return {
            name: fnName,
            description,
            inputSchema,
            handler: async (args) => {
              if (abortController.signal.aborted || shouldEndAgenticTurn?.()) return endedToolResult();
              const callId = `call_${uuidv4()}`;
              const argsJson = JSON.stringify(args ?? {});
              // The bridge receives a call only after Antigravity CLI has assembled its
              // arguments. Surface it immediately, before approval or execution,
              // so the existing UI renders a live pending tool card whose
              // arguments stream in (#337) instead of appearing all at once.
              await streamToolCall({ id: callId, name: fnName, argsJson });
              const denied = await gate(callId, fnName, args ?? {});
              if (denied) return denied;
              await checkToolFence();
              log.debug('Antigravity CLI local tool call', { tool: fnName });
              const toolStartedAt = Date.now();
              let resultContent: string;
              let isError = false;
              try {
                resultContent = JSON.stringify(await localExec(args ?? {})) ?? 'null';
                await afterToolDispatch?.();
              } catch (err) {
                if ((err as { code?: unknown })?.code === 'flow_execution_authority_lost') throw err;
                resultContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
              recordToolResult({ id: callId, resultContent });
              if (runId) {
                recordStatisticsEvent(createStatisticsEvent({
                  type: 'tool.invocation',
                  runId,
                  node: nodeId ? { id: nodeId } : undefined,
                  tool: { id: fnName, name: fnName, kind: 'synthetic' },
                  outcome: isError ? 'error' : 'completed',
                  durationMs: Math.max(0, Date.now() - toolStartedAt),
                  errorClass: isError ? classifyStatisticsError({ type: 'tool' }) : undefined,
                }));
              }
              return isError
                ? { content: [{ type: 'text', text: resultContent }], isError: true }
                : { content: [{ type: 'text', text: resultContent }] };
            },
          };
        }

        const {
          server,
          tool: originalTool,
          timeout,
          nodeId: callerNodeId,
          annotations,
          uiResourceUri,
          presetArgs,
          context,
        } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return {
          name: readableName,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
          handler: async (args) => {
            if (abortController.signal.aborted || shouldEndAgenticTurn?.()) return endedToolResult();
            const callId = `call_${uuidv4()}`;
            const argsJson = JSON.stringify(args ?? {});
            // Emit before the approval gate and mcpService call. Large/slow tools
            // therefore appear in chat as pending as soon as the MCP request
            // reaches FLUJO instead of after their result is available, with the
            // arguments paced into the card while they are still being read (#337).
            await streamToolCall({ id: callId, name: readableName, argsJson });
            const effectiveArgs = await applyPresetArguments(args ?? {}, presetArgs, context);
            const denied = await gate(
              callId,
              readableName,
              args ?? {},
              async (reason) => {
                const link = await resolveInvokedToolUiLink(
                  server,
                  originalTool,
                  uiResourceUri,
                  undefined,
                  args ?? {},
                );
                return link
                  ? { ...link, cancelledReason: reason, isError: true }
                  : undefined;
              },
            );
            if (denied) return denied;
            await checkToolFence();
            await authorizePersonaCoreMcp?.(server, callerNodeId);
            log.debug('Antigravity CLI tool call', { server, tool: originalTool, exposedAs: readableName });
            const toolStartedAt = Date.now();
            const result = await mcpService.callTool(
              server,
              originalTool,
              effectiveArgs,
              timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
              onToolProgress
                ? (progress) => onToolProgress({
                    toolCallId: callId,
                    name: readableName,
                    progress: progress.progress,
                    total: progress.total,
                    message: progress.message,
                  })
                : undefined,
              callerNodeId,
              abortController.signal,
              'model',
              // Issue #413: the self-orchestrating adapters must derive the SAME
              // run owner key as the normal ModelHandler path. Without it a
              // Antigravity CLI-driven Bash session landed under `caller:<nodeId>` and was
              // never released when the run ended.
              ownerScopeForRun({ runId, conversationId }),
              conversationId ? { conversationId } : undefined,
            );
            await afterToolDispatch?.();
            if (runId) {
              const cancelled = Boolean(abortController.signal.aborted || toolCancellationReason(result));
              recordStatisticsEvent(createStatisticsEvent({
                type: 'tool.invocation',
                runId,
                node: { id: callerNodeId ?? nodeId ?? 'unknown' },
                tool: { id: originalTool, name: originalTool, kind: 'mcp' },
                provider: { id: server },
                outcome: cancelled ? 'cancelled' : result.success ? 'completed' : 'error',
                durationMs: Math.max(0, Date.now() - toolStartedAt),
                errorClass: !result.success ? classifyStatisticsError(cancelled ? { type: 'cancelled' } : result.error) : undefined,
              }));
            }
            let callResult: CallToolResult;
            let resultContent: string;
            if (result.success) {
              callResult = result.data as CallToolResult;
              // Media is exempt from the size bound, same rationale as the
              // subscription path: base64 measured against a byte budget
              // silently deleted every real image (a ~37 KB picture already
              // blows the 50 KB default once stringified). Bound the text,
              // forward the media blocks untouched over the MCP bridge.
              const { mediaItems, textResult } = splitToolResultMedia(callResult);
              resultContent = JSON.stringify(textResult);
              // Tool-boundary bound (#251), same as the subscription path: this
              // bypasses ModelHandler's processToolCalls, so bound here or the
              // guarantee silently wouldn't apply on Antigravity CLI runs.
              if (conversationId) {
                const bound = async () => {
                  try {
                    const settings = await getRunResourceSettings();
                    return await boundToolResult({
                      conversationId,
                      toolCallId: callId,
                      server,
                      toolName: originalTool,
                      nodeId: callerNodeId,
                      content: resultContent,
                      settings,
                    });
                  } catch (err) {
                    rethrowFlowExecutionAuthorityError(err);
                    log.warn('boundToolResult failed on Antigravity CLI path; keeping full result', err);
                    return null;
                  }
                };
                const bounded = commitDurableMutation
                  ? await commitDurableMutation(bound)
                  : await bound();
                if (bounded?.spilled) {
                  resultContent = bounded.content;
                  callResult = {
                    ...callResult,
                    content: [...mediaItems, { type: 'text', text: bounded.content }],
                  };
                  // The resource receipt replaces the text payload in both MCP
                  // representations; retaining structuredContent would resend it.
                  delete callResult.structuredContent;
                }
              }
            } else {
              resultContent = `Error: ${result.error ?? 'Unknown error'}`;
              callResult = { content: [{ type: 'text', text: resultContent }], isError: true };
            }
            const uiLink = await resolveInvokedToolUiLink(
              server,
              originalTool,
              uiResourceUri,
              result.data,
              args ?? {},
            );
            const cancelledReason = toolCancellationReason(result);
            const ui = uiLink
              ? {
                  ...uiLink,
                  ...(!result.success ? { isError: true } : {}),
                  ...(cancelledReason ? { cancelledReason } : {}),
                }
              : undefined;
            recordToolResult({
              id: callId,
              resultContent,
              ...(ui ? { ui } : {}),
            });
            return callResult;
          },
        };
      })
      .filter((t): t is BridgeTool => t !== null);


    const checkToolFence = async (): Promise<void> => {
      if (abortController.signal.aborted) throw antigravityCliAbortError();
      if (shouldEndAgenticTurn?.()) throw new Error('This agentic turn has ended.');
      await beforeToolDispatch?.();
      if (abortController.signal.aborted) throw antigravityCliAbortError();
      if (shouldEndAgenticTurn?.()) throw new Error('This agentic turn has ended.');
    };
    let activeToolCount = 0;
    let onToolsIdle: (() => void) | undefined;
    const waitForTools = async (): Promise<void> => {
      if (activeToolCount) await new Promise<void>(resolve => { onToolsIdle = resolve; });
    };
    const bridgeTools: BridgeTool[] = unguardedBridgeTools.map(tool => ({
      ...tool,
      handler: async args => {
        flushText();
        if (endSpawning || abortController.signal.aborted || shouldEndAgenticTurn?.()) return endedToolResult();
        if (handoffCalls.length && !isHandoffName(tool.name)) {
          endSpawning = true;
          activeChild?.abort();
          return endedToolResult();
        }
        activeToolCount++;
        try {
          if (++bridgeDispatches > maxTurns) {
            fatalError = new Error('Antigravity CLI exceeded the FLUJO tool dispatch budget.');
            abortController.abort(); activeChild?.abort();
            throw fatalError;
          }
          return antigravityBridgeResult(await tool.handler(args));
        } catch (error) {
          // The HTTP bridge converts thrown failures to MCP errors. Keep a lost
          // execution fence fatal to the model run, rather than letting it retry.
          try { rethrowFlowExecutionAuthorityError(error); } catch (authorityError) {
            fatalError = authorityError;
            abortController.abort();
            activeChild?.abort();
          }
          settlePendingTools(error instanceof Error && error.name === 'AbortError' ? 'tool cancelled' : 'tool failed');
          throw error;
        } finally {
          activeToolCount--;
          if (!activeToolCount) { onToolsIdle?.(); onToolsIdle = undefined; }
          if (endSpawning || shouldEndAgenticTurn?.()) {
            endedByCaller = handoffCalls.length === 0;
            activeChild?.abort();
          }
        }
      },
    }));

    let pendingText = '';
    let pendingMessageId = getStreamMessageId(`text_${uuidv4()}`);
    let resultText = '';
    let liveMessageId: string | undefined;
    const flushText = (): void => {
      if (!pendingText) return;
      resultText = pendingText;
      liveMessageId = pendingMessageId;
      recordMessage({ role: 'assistant', content: pendingText }, pendingMessageId);
      pendingText = '';
      pendingMessageId = getStreamMessageId(`text_${uuidv4()}`);
    };
    const settlePendingTools = (reason: string): void => {
      for (const id of unansweredTools) recordToolResult({ id, resultContent: reason });
    };
    const source = steeringSource(input);
    let steeringDelivery: SteeringDelivery | undefined;
    let activeDelivery: SteeringDelivery | undefined;
    let startedChild = false;
    const watcher = watchSteering({
      source,
      canDeliver: () => startedChild && !activeToolCount && !steeringDelivery && !abortController.signal.aborted && !endSpawning && !handoffCalls.length,
      deliver: async batch => {
        await batch.beforeSend();
        if (activeToolCount || abortController.signal.aborted || endSpawning || handoffCalls.length) { batch.requeue(); return; }
        steeringDelivery = batch;
        activeChild?.abort();
      },
      onError: error => { fatalError = error; activeChild?.abort(); },
    });
    let runtime: AntigravityCliRuntime | undefined;
    let bridge: Awaited<ReturnType<typeof startCodexToolBridge>> | undefined;
    const usage = mapAntigravityCliUsage(undefined);
    const runMessages: OpenAI.ChatCompletionMessageParam[] = [...messages];
    try {
      if (abortController.signal.aborted) throw antigravityCliAbortError();
      if (shouldEndAgenticTurn?.()) endedByCaller = true;
      if (!endedByCaller) {
        if (bridgeTools.length) bridge = await startCodexToolBridge(bridgeTools);
        runtime = await prepareAntigravityCliRuntime({
          model: model.name, apiKey, maxTurns,
          ...(bridge ? { bridge: { url: bridge.url, tools: bridgeTools.map(tool => tool.name), definitions: bridgeTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } } : {}),
        });
        let remainingTurns = maxTurns;
        while (!endedByCaller && !endSpawning && !handoffCalls.length) {
          if (abortController.signal.aborted) throw antigravityCliAbortError();
          if (fatalError) throw fatalError;
          if (remainingTurns-- <= 0) throw new Error('Antigravity CLI exceeded the steering turn limit.');
          activeChild = new AbortController();
          const normalized = normalizeMessageInput(runMessages, runResourceMarkers);
          const prompt = prepareAntigravityCliPrompt([normalized.systemPrompt ? `<system_instructions>\n${normalized.systemPrompt}\n</system_instructions>` : '', normalized.text].filter(Boolean).join('\n\n'));
          let finalResult: Extract<AntigravityCliEvent, { event: 'result' }>['result'] | undefined;
          let cliConversationId: string | undefined;
          let streamError = false;
          let textSinceTool = false;
          const transcriptStart = transcript.length;
          try {
            await observeSdkRequest(input, {
              adapter: 'antigravity-cli', operation: 'agy --input-format stream-json --output-format stream-json',
              request: { model: model.name, prompt, toolDispatchBudget: maxTurns, stepBudget: maxTurns * 8 + 16, tools: bridgeTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
              wireMessages: [...runMessages],
            }, () => runAntigravityCli({
              runtime: runtime!, model: model.name, prompt, signal: activeChild!.signal, timeoutMs: deadlineAt - Date.now(),
              onStarted: async () => { startedChild = true; await activeDelivery?.acknowledge(); activeDelivery = undefined; },
              onEvent: event => {
                if (fatalError) throw fatalError;
                if (shouldEndAgenticTurn?.()) { endedByCaller = true; activeChild?.abort(); return; }
                if (event.event === 'init') {
                  if (cliConversationId || event.init.agent !== 'flujo' || event.init.permission_mode !== 'request-review') throw new Error('Antigravity CLI returned an unexpected invocation configuration.');
                  cliConversationId = event.conversation_id;
                } else if (event.event === 'step_update') {
                  const step = event.step_update;
                  if (step.conversation_id !== cliConversationId) throw new Error('Antigravity CLI changed conversation identity.');
                  seenSteps.add(`${cliConversationId}:${step.step_index}`);
                  if (seenSteps.size > maxTurns * 8 + 16) throw new Error('Antigravity CLI exceeded the FLUJO execution step budget.');
                  if (step.step_type === 'error_message') streamError = true;
                  if (step.step_type === 'tool') {
                    if (!['call_mcp_tool', 'list_resources', 'read_resource', 'manage_task'].includes(step.tool_name ?? '')) throw new Error('Antigravity CLI attempted an unbound native tool.');
                    if (step.tool_name !== 'manage_task') {
                      const parameters = step.tool_info?.parameters;
                      if (parameters?.ServerName !== 'flujo'
                        || (step.tool_name === 'call_mcp_tool' && !bridgeTools.some(tool => tool.name === parameters.ToolName))) throw new Error('Antigravity CLI attempted an unbound MCP tool.');
                    }
                    if (textSinceTool) { flushText(); textSinceTool = false; }
                  }
                  if (step.step_type !== 'agent_response') return;
                  if (handoffCalls.length) { endSpawning = true; activeChild?.abort(); return; }
                  if (finalResult) throw new Error('Antigravity CLI emitted text after its final result.');
                  const delta = step.text_delta ?? '';
                  pendingText += delta;
                  textSinceTool ||= Boolean(delta);
                  if (delta) onModelDelta?.({ messageId: pendingMessageId, contentDelta: delta });
                } else if (event.event === 'result') {
                  if (finalResult) throw new Error('Antigravity CLI emitted duplicate final results.');
                  if (event.result.conversation_id !== cliConversationId) throw new Error('Antigravity CLI changed conversation identity.');
                  finalResult = event.result;
                  if (!pendingText && finalResult.response) {
                    pendingText = finalResult.response;
                    onModelDelta?.({ messageId: pendingMessageId, contentDelta: finalResult.response });
                  } else if (finalResult.response && finalResult.response !== pendingText) {
                    if (!finalResult.response.startsWith(pendingText)) throw new Error('Antigravity CLI final text disagreed with its stream.');
                    const suffix = finalResult.response.slice(pendingText.length);
                    pendingText += suffix;
                    if (suffix) onModelDelta?.({ messageId: pendingMessageId, contentDelta: suffix });
                  }
                  const turnUsage = mapAntigravityCliUsage(event.result.usage);
                  usage.prompt_tokens += turnUsage.prompt_tokens;
                  usage.completion_tokens += turnUsage.completion_tokens;
                  usage.total_tokens += turnUsage.total_tokens;
                  usage.prompt_tokens_details!.cached_tokens! += turnUsage.prompt_tokens_details?.cached_tokens ?? 0;
                  usage.completion_tokens_details!.reasoning_tokens! += turnUsage.completion_tokens_details?.reasoning_tokens ?? 0;
                  if (event.result.status !== 'SUCCESS') streamError = true;
                }
              },
            }));
            if (!finalResult || finalResult.status !== 'SUCCESS' || streamError) throw new Error(`Antigravity CLI failed to complete a valid response. Check model access and your Google account login or Gemini API key.${antigravityCliFailureHint(finalResult?.error ?? '')}`);
          } catch (error) {
            if (fatalError) throw fatalError;
            if (abortController.signal.aborted) throw antigravityCliAbortError();
            if (!steeringDelivery && !endSpawning && !handoffCalls.length && !endedByCaller) throw error;
          } finally {
            startedChild = false;
            await waitForTools();
            flushText();
            settlePendingTools('tool cancelled');
          }
          if (!steeringDelivery) break;
          activeDelivery = steeringDelivery;
          steeringDelivery = undefined;
          runMessages.push(...transcript.slice(transcriptStart));
          for (const message of activeDelivery.messages) {
            recordSteeringMessage(message);
            runMessages.push(message as OpenAI.ChatCompletionMessageParam);
          }
          await activeDelivery.beforeSend();
        }
      }
    } finally {
      await watcher.stop();
      signal?.removeEventListener('abort', onExternalAbort);
      activeChild?.abort();
      await waitForTools();
      activeDelivery?.requeue();
      steeringDelivery?.requeue();
      flushText();
      settlePendingTools('tool cancelled');
      try { await bridge?.close(); } finally { await runtime?.cleanup(); }
    }
    if (fatalError) throw fatalError;
    if (abortController.signal.aborted) throw antigravityCliAbortError();
    const finalToolCalls = handoffCalls.length ? handoffCalls.map(handoff => ({
      id: `call_${uuidv4()}`, type: 'function' as const,
      function: { name: handoff.name, arguments: JSON.stringify(handoff.args) },
    })) : undefined;
    if (finalToolCalls) recordMessage({ role: 'assistant', content: null, tool_calls: finalToolCalls });
    return {
      completion: {
        id: `antigravity_cli_${uuidv4()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name,
        choices: [{ index: 0, finish_reason: finalToolCalls ? 'tool_calls' : 'stop', logprobs: null,
          message: { role: 'assistant', content: resultText || null, refusal: null, ...(finalToolCalls ? { tool_calls: finalToolCalls } : {}) } }],
        usage,
      },
      transcript, liveMessageId, contextUsage: null,
    };
  }
}
