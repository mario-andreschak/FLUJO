import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { getRunResourceSettings } from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import {
  resolveAdvertisedToolUiLink,
  toolCancellationReason,
} from '@/backend/mcpApps/toolUi';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { FlujoChatMessage } from '@/shared/types/chat';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { normalizeMessageInput } from './messageNormalization';
import { startCodexToolBridge, BridgeTool } from './codexToolBridge';
import { resolveCodexModelCatalogPath } from './codexModelCatalog';
import { prepareCodexRuntimeEnvironment } from './codexRuntimeHome';
import {
  codexSessionKey,
  computeCodexPrefixHash,
  computeCodexHistoryHash,
  findReusableCodexSession,
  recordCodexSession,
  invalidateCodexSession,
} from './codexSessionStore';
import { extractNativeMediaParts } from './messageUtils';

const log = createLogger('backend/services/model/adapters/codexAdapter');

// Mirror of the Claude adapter's readable-name scheme: `<server>__<tool>`,
// unique, charset/length-safe. The handler closes over the real (server, tool),
// so the name only has to be stable within the run — not decodable.
const MAX_TOOL_NAME_LEN = 110;

// Local mirror of MAX_DYNAMIC_FANOUT_LANES (SubflowNode) — prep re-caps the
// briefs anyway; this only stops a runaway spawn loop from burning turns.
const MAX_SPAWN_CALLS = 32;

// Fixed, short developer-level contract for the SDK integration. The flow's
// potentially-large dynamic system prompt still travels over stdin, avoiding
// Windows command-line limits; this invariant is small enough for `--config`
// and prevents Codex from confusing its neutral runtime cwd/sandbox with the
// separate filesystem authority exposed by FLUJO's MCP bridge.
export const CODEX_FLUJO_INSTRUCTIONS =
  'FLUJO MCP tools are the authoritative interface for the operations they expose. ' +
  'When filesystem__ tools are available, use them for all file operations; they run outside the Codex sandbox under FLUJO-managed roots and approvals, so a path may be valid even when it is outside the Codex working directory. ' +
  'Call filesystem__get_allowed_directories before guessing roots, and do not inspect the Codex runtime working directory unless the user explicitly asks.';

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

function codexImageExtension(mimeType: string | undefined): string {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/png':
    default:
      return 'png';
  }
}

const CODEX_CONNECTION_CLOSED_MID_RESPONSE =
  'Connection closed mid-response. The response above may be incomplete.';

/** Only the SDK's precise mid-stream transport close is safe to continue. */
function isRetryableCodexConnectionClose(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(CODEX_CONNECTION_CLOSED_MID_RESPONSE);
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

/** The Codex SDK usage block (turn.completed). */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Codex adapter — drives OpenAI's `codex` CLI through the Codex SDK
 * (`@openai/codex-sdk`, which bundles the CLI). Authentication is either an
 * OpenAI API key in the model's API Key field (passed to the SDK, which injects
 * it as CODEX_API_KEY into the subprocess) or — when the key is left empty —
 * the machine's ChatGPT-plan login from `codex login` (~/.codex/auth.json).
 *
 * Modeled on ClaudeSubscriptionAdapter (issue #301): tool calling is agentic.
 * FLUJO's tools are re-exposed to the CLI as a per-run loopback streamable-HTTP
 * MCP server (see codexToolBridge — the Codex SDK has no in-process MCP seam),
 * whose handlers dispatch to `mcpService` so every call executes AND is
 * observed inside FLUJO. Each captured assistant/tool message is BOTH streamed
 * live (via `onTranscriptMessage`) AND collected into the returned `transcript`.
 * Handoff tools are exposed too, with the same spawn-with-brief semantics as
 * the Claude path (issue #156): every handoff call of the routing turn is
 * surfaced as a tool_call so FLUJO's edge routing fires.
 *
 * The approval gate (`requestToolApproval`) is enforced INSIDE the bridge
 * handlers, before dispatch — the Codex SDK has no canUseTool equivalent.
 *
 * Disable Codex's default shell tool with `features.shell_tool = false`. A
 * complete internal-tool allowlist is not available in the SDK. The thread
 * runs in a stable neutral runtime directory, while the loopback MCP bridge is
 * hosted by FLUJO's Node process so its filesystem tools retain their own
 * FLUJO authorization.
 * `approvalPolicy: 'never'` keeps the CLI from blocking on interactive
 * shell approval prompts it has no way to deliver. The SDK subprocess also
 * receives a FLUJO-managed CODEX_HOME so personal MCP servers and plugins do
 * not become undeclared tools in a flow run.
 *
 * Like the Claude adapter, `temperature`/`maxTokens` are not applicable (the
 * CLI owns sampling), and `maxTurns` has no SDK knob — the run is bounded by
 * Codex's own turn management. Full-history nodes reuse the SDK thread per
 * `(conversationId, nodeId)` and send only messages beyond its watermark;
 * scoped views and prefix/history divergence fall back to a fresh full flatten.
 */
export class CodexAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    const {
      model,
      apiKey,
      messages,
      tools,
      toolNameMap,
      localToolExecutors,
      requestToolApproval,
      onTranscriptMessage,
      onModelDelta,
      signal,
      conversationId,
      nodeId,
      runResourceMarkers,
      sessionResume,
      codexSession,
      onCodexSessionChange,
    } = input;
    // Lazy-load the Codex SDK: ESM-only, so a module-scope import would break
    // the CommonJS Jest transform for every module referencing the adapter
    // factory (same reason the Agent SDK is imported lazily).
    const { Codex } = await import('@openai/codex-sdk');

    const fullInput = normalizeMessageInput(messages, runResourceMarkers);
    const { systemPrompt } = fullInput;

    const abortController = new AbortController();
    const onExternalAbort = () => abortController.abort();
    if (signal?.aborted) {
      abortController.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Transcript recording — identical contract to the Claude adapter: stable
    // ids, streamed live as produced, returned for persistence.
    const transcript: FlujoChatMessage[] = [];
    const baseTs = Date.now();
    let txSeq = 0;
    // Codex item ids (for example `item_0`) are only unique within one SDK
    // turn. A Flow can invoke this adapter many times in the same conversation,
    // so using the raw item id as the durable chat-message id makes later turns
    // overwrite earlier streamed messages and gives React duplicate keys.
    // Namespace every item with this adapter invocation while keeping the id
    // stable across item.started/updated/completed events for reconciliation.
    const streamMessageNamespace = `${baseTs}_${uuidv4()}`;
    const getStreamMessageId = (itemId: string): string =>
      `stream_codex_${streamMessageNamespace}_${itemId}`;
    const recordMessage = (msg: TranscriptMessage, id = `m_${uuidv4()}`): void => {
      const full = { ...msg, id, timestamp: baseTs + txSeq++ } as FlujoChatMessage;
      transcript.push(full);
      onTranscriptMessage?.(full);
    };
    const recordToolCall = (ti: Pick<ToolInteraction, 'id' | 'name' | 'argsJson'>): void => {
      recordMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      });
    };
    const recordToolResult = (ti: Pick<ToolInteraction, 'id' | 'resultContent' | 'ui'>): void => {
      recordMessage({
        role: 'tool',
        tool_call_id: ti.id,
        content: ti.resultContent,
        ...(ti.ui ? { ui: ti.ui } : {}),
      });
    };
    const recordToolPair = (ti: ToolInteraction): void => {
      recordToolCall(ti);
      recordToolResult(ti);
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
      const { approved, feedback } = await requestToolApproval({ id: callId, name, args });
      if (approved) return null;
      const rejectionText = feedback
        ? `User rejected this tool call: ${feedback}`
        : 'Tool call rejected by the user.';
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
    const usedNames = new Set<string>();
    const bridgeTools: BridgeTool[] = (tools ?? [])
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
              handoffCalls.push({ name: fnName, args: args ?? {} });
              log.debug('Codex requested handoff', { tool: fnName, callIndex: handoffCalls.length, spawnable });
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
              const callId = `call_${uuidv4()}`;
              const argsJson = JSON.stringify(args ?? {});
              // The bridge receives a call only after Codex has assembled its
              // arguments. Surface it immediately, before approval or execution,
              // so the existing UI renders a live pending tool card.
              recordToolCall({ id: callId, name: fnName, argsJson });
              const denied = await gate(callId, fnName, args ?? {});
              if (denied) return denied;
              log.debug('Codex local tool call', { tool: fnName });
              let resultContent: string;
              let isError = false;
              try {
                resultContent = JSON.stringify(await localExec(args ?? {}));
              } catch (err) {
                resultContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
              recordToolResult({ id: callId, resultContent });
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
        } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return {
          name: readableName,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
          handler: async (args) => {
            const callId = `call_${uuidv4()}`;
            const argsJson = JSON.stringify(args ?? {});
            // Emit before the approval gate and mcpService call. Large/slow tools
            // therefore appear in chat as pending as soon as the MCP request
            // reaches FLUJO instead of after their result is available.
            recordToolCall({ id: callId, name: readableName, argsJson });
            const denied = await gate(
              callId,
              readableName,
              args ?? {},
              async (reason) => {
                const link = await resolveAdvertisedToolUiLink(
                  server,
                  originalTool,
                  uiResourceUri,
                );
                return link
                  ? { ...link, cancelledReason: reason, isError: true }
                  : undefined;
              },
            );
            if (denied) return denied;
            log.debug('Codex tool call', { server, tool: originalTool, exposedAs: readableName });
            const result = await mcpService.callTool(
              server,
              originalTool,
              args ?? {},
              timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
              undefined,
              callerNodeId,
              abortController.signal,
              'model',
            );
            let callResult: CallToolResult;
            let resultContent: string;
            if (result.success) {
              callResult = result.data as CallToolResult;
              resultContent = JSON.stringify(result.data);
              // Tool-boundary bound (#251), same as the subscription path: this
              // bypasses ModelHandler's processToolCalls, so bound here or the
              // guarantee silently wouldn't apply on Codex runs.
              if (conversationId) {
                try {
                  const settings = await getRunResourceSettings();
                  const bounded = await boundToolResult({
                    conversationId,
                    toolCallId: callId,
                    server,
                    toolName: originalTool,
                    nodeId: callerNodeId,
                    content: resultContent,
                    settings,
                  });
                  if (bounded.spilled) {
                    resultContent = bounded.content;
                    callResult = { content: [{ type: 'text', text: bounded.content }] };
                  }
                } catch (err) {
                  log.warn('boundToolResult failed on Codex path; keeping full result', err);
                }
              }
            } else {
              resultContent = `Error: ${result.error ?? 'Unknown error'}`;
              callResult = { content: [{ type: 'text', text: resultContent }], isError: true };
            }
            const uiLink = await resolveAdvertisedToolUiLink(
              server,
              originalTool,
              uiResourceUri,
              result.data,
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

    // Full-history session reuse. Prefix drift, a shortened history, a scoped
    // input view (`sessionResume` false), or an empty delta all take the
    // always-correct fresh/full-flatten path.
    const sessionRegistryKey =
      conversationId && nodeId ? codexSessionKey(conversationId, nodeId) : undefined;
    if (!sessionResume && sessionRegistryKey) {
      // Scoped/isolated history cannot be reconciled with a previously persisted
      // full-history thread. Drop it now so a later full-history turn never
      // resumes across this divergence.
      invalidateCodexSession(sessionRegistryKey);
      onCodexSessionChange?.(undefined);
    }
    const configuration = {
      adapter: model.adapter ?? 'codex-cli',
      provider: model.provider ?? 'openai',
      model: model.name,
      reasoningEffort: model.reasoningEffort,
    };
    const sessionTracking =
      sessionResume && conversationId && nodeId
        ? {
            key: sessionRegistryKey!,
            configuration,
            prefixHash: computeCodexPrefixHash(configuration, systemPrompt, bridgeTools),
          }
        : undefined;
    let resumeThreadId: string | undefined;
    let normalizedInput = fullInput;
    let inputSystemPrompt = systemPrompt;
    if (sessionTracking) {
      const reusable = findReusableCodexSession(
        sessionTracking.key,
        sessionTracking.prefixHash,
        messages,
        codexSession,
      );
      if (reusable && messages.length > reusable.seenMessageCount) {
        const delta = normalizeMessageInput(
          messages.slice(reusable.seenMessageCount),
          runResourceMarkers,
        );
        if (delta.text.length > 0 || delta.images.length > 0) {
          resumeThreadId = reusable.threadId;
          normalizedInput = delta;
          // The original system prompt is already in the persisted Codex thread.
          inputSystemPrompt = undefined;
          log.debug('Codex resuming SDK thread', {
            conversationId,
            nodeId,
            threadId: resumeThreadId,
            seenMessageCount: reusable.seenMessageCount,
            deltaMessages: messages.length - reusable.seenMessageCount,
          });
        }
      }
    }

    // Flattened history → Codex stdin input. Keep the dynamic system prompt out of
    // Codex SDK config: the SDK serializes config values into CLI arguments,
    // which can exceed Windows' command-line limit for flow-generation prompts.
    // Base64 images alone use an ephemeral scratch directory; ordinary turns use
    // the stable neutral runtime cwd prepared below.
    const tempFiles: string[] = [];
    let scratchDir: string | undefined;
    const ensureScratchDir = async (): Promise<string> => {
      if (!scratchDir) scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-'));
      return scratchDir;
    };

    type CodexInputItem = { type: 'text'; text: string } | { type: 'local_image'; path: string };
    const inputItems: CodexInputItem[] = [];
    if (inputSystemPrompt) {
      inputItems.push({
        type: 'text',
        text: `<system_instructions>\n${inputSystemPrompt}\n</system_instructions>`,
      });
    }
    if (normalizedInput.text) {
      inputItems.push({ type: 'text', text: normalizedInput.text });
    }
    for (const image of normalizedInput.images) {
      if (image.base64) {
        const dir = await ensureScratchDir();
        const ext = codexImageExtension(image.mimeType);
        const file = path.join(dir, `img_${tempFiles.length}.${ext}`);
        await fs.writeFile(file, Buffer.from(image.base64, 'base64'));
        tempFiles.push(file);
        inputItems.push({ type: 'local_image', path: file });
      } else {
        // Remote URLs can't be attached (the CLI reads local paths only);
        // reference them in text so the model at least knows they exist.
        inputItems.push({ type: 'text', text: `[image: ${image.url}]` });
      }
    }

      }
    }

    let bridge: Awaited<ReturnType<typeof startCodexToolBridge>> | undefined;
    let resultText = '';
    let usage: CodexUsage | undefined;
    let streamedText = false;
    let failure: string | undefined;
    let completedTurn = false;
    let capturedThreadId = resumeThreadId;

    try {
      if (bridgeTools.length > 0) {
        bridge = await startCodexToolBridge(bridgeTools, CODEX_FLUJO_INSTRUCTIONS);
      }

      const modelCatalogPath = await resolveCodexModelCatalogPath();
      const runtime = await prepareCodexRuntimeEnvironment(!apiKey);
      const config = {
        // A user's Codex app/CLI Fast-mode preference is global. Do not let a
        // personal `service_tier = "priority"` leak into FLUJO when its selected
        // model (for example gpt-5.4-mini) does not advertise that tier: the CLI
        // completes the turn but exits non-zero after printing the warning.
        service_tier: model.serviceTier ?? 'default',
        developer_instructions: CODEX_FLUJO_INSTRUCTIONS,
        // Do not expose Codex's built-in shell. FLUJO filesystem operations
        // must go through the bridged MCP tools so they remain observable and
        // subject to FLUJO's approval and protected-path policies.
        features: {
          shell_tool: false,
        },
        ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {}),
        ...(bridge
          ? {
              mcp_servers: {
                flujo: {
                  url: bridge.url,
                  // Codex's MCP approval layer cannot delegate a prompt through
                  // the TypeScript SDK. Let the call reach the bridge; FLUJO's
                  // requestToolApproval gate remains authoritative in-handler.
                  default_tools_approval_mode: 'approve',
                },
              },
            }
          : {}),
      };
      const codex = new Codex({
        ...(apiKey ? { apiKey } : {}), // empty ⇒ ChatGPT-plan login from `codex login`
        env: runtime.env,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });

      const threadOptions = {
        model: model.name,
        ...(model.reasoningEffort
          ? {
              // The bundled SDK type currently ends at xhigh, while newer Codex
              // catalogs also advertise max/ultra; the CLI accepts the catalog value.
              modelReasoningEffort: model.reasoningEffort as
                | 'minimal'
                | 'low'
                | 'medium'
                | 'high'
                | 'xhigh',
            }
          : {}),
        workingDirectory: runtime.workingDirectory,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
      } as const;
      const thread = resumeThreadId
        ? codex.resumeThread(resumeThreadId, threadOptions)
        : codex.startThread(threadOptions);

      log.debug('createCompletion via Codex SDK', {
        model: model.name,
        toolCount: bridgeTools.length,
        hasSystem: Boolean(systemPrompt),
        bridged: Boolean(bridge),
        resumed: Boolean(resumeThreadId),
        workingDirectory: runtime.workingDirectory,
        usingLocalModelCatalog: Boolean(modelCatalogPath),
      });

      const initialInput =
        inputItems.length === 1 && inputItems[0].type === 'text' ? inputItems[0].text : inputItems;
      const continuationInput =
        'Continue the interrupted response from exactly where it stopped. Do not repeat content or tool calls already completed.';

      // A network close can occur after the CLI has emitted useful partial
      // output. Resume the same SDK thread once, preserving its tool state and
      // appending only newly streamed assistant messages to the transcript.
      const streamedAgentText = new Map<string, string>();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let attemptFailure: Error | undefined;
        try {
          const { events } = await thread.runStreamed(
            attempt === 0 ? initialInput : continuationInput,
            { signal: abortController.signal },
          );

          for await (const event of events) {
            if (signal?.aborted) break;
            if (event.type === 'thread.started') {
              capturedThreadId = event.thread_id;
              continue;
            }
            // Handoff end conditions (issue #156), mirroring the Claude adapter: a
            // PLAIN handoff ends the run at the next streamed event; SPAWN handoffs
            // end when the model produces a message without another call — or at
            // the runaway cap.
            if (handoffCalls.length > 0 && (endSpawning || handoffCalls.length >= MAX_SPAWN_CALLS)) {
              abortController.abort();
              break;
            }
            if (
              event.type === 'item.started' ||
              event.type === 'item.updated' ||
              event.type === 'item.completed'
            ) {
              const item = event.item;
              if (item.type === 'agent_message') {
                const prior = streamedAgentText.get(item.id) ?? '';
                const delta = item.text.startsWith(prior) ? item.text.slice(prior.length) : item.text;
                if (delta) {
                  onModelDelta?.({
                    messageId: getStreamMessageId(item.id),
                    contentDelta: delta,
                  });
                }
                streamedAgentText.set(item.id, item.text);
              }
            }
            if (event.type === 'item.completed') {
              const item = event.item;
              const itemMedia = extractNativeMediaParts(item);
              if (itemMedia.length > 0 && item.type !== 'agent_message') {
                recordMessage(
                  { role: 'assistant', content: '', media: itemMedia },
                  getStreamMessageId(item.id),
                );
                streamedText = true;
              } else if (item.type === 'agent_message') {
                const messageMedia = extractNativeMediaParts(
                  (item as unknown as { content?: unknown }).content,
                );
                // A message AFTER spawning means the model stopped queueing
                // workers: end the run without accumulating post-handoff narration.
                if (handoffCalls.length > 0) {
                  abortController.abort();
                  break;
                }
                if (item.text || messageMedia.length > 0) {
                  resultText += (resultText ? '\n\n' : '') + item.text;
                  recordMessage({
                    role: 'assistant',
                    content: item.text,
                    ...(messageMedia.length ? { media: messageMedia } : {}),
                  }, getStreamMessageId(item.id));
                  streamedText = true;
                }
              } else if (item.type === 'command_execution') {
                recordToolPair({
                  id: `call_${uuidv4()}`,
                  name: 'shell',
                  argsJson: JSON.stringify({ command: item.command }),
                  resultContent: item.aggregated_output ?? '',
                });
              } else if (item.type === 'error') {
                log.warn('Codex reported a non-fatal item', { message: item.message });
              }
              // mcp_tool_call items are deliberately NOT recorded here — the bridge
              // handlers already record each call/result pair (with approval and
              // bounding applied), so mirroring the item would duplicate them.
            } else if (event.type === 'turn.completed') {
              usage = event.usage as CodexUsage;
              completedTurn = true;
            } else if (event.type === 'turn.failed') {
              attemptFailure = new Error(
                (event as { error?: { message?: string } }).error?.message ?? 'unknown error',
              );
            }
          }
        } catch (err) {
          attemptFailure = err instanceof Error ? err : new Error(String(err));
        }

        if (signal?.aborted && handoffCalls.length === 0) {
          throw new Error('Codex run cancelled by user.');
        }
        if (!attemptFailure || handoffCalls.length > 0) break;
        if (attempt === 0 && !abortController.signal.aborted && isRetryableCodexConnectionClose(attemptFailure)) {
          log.warn('Codex connection closed mid-response; continuing the same thread once');
          continue;
        }
        failure = attemptFailure.message;
        break;
      }

      if (failure && handoffCalls.length === 0) {
        throw new Error(`Codex run failed: ${failure}`);
      }
    } catch (err) {
      if (sessionTracking) {
        invalidateCodexSession(sessionTracking.key);
        onCodexSessionChange?.(undefined);
      }
      // A stale/missing persisted thread must not lose the current user request.
      // Retry exactly once from the full flattened history on a new SDK thread.
      if (resumeThreadId && handoffCalls.length === 0) {
        log.warn('Codex SDK thread resume failed; retrying on a fresh thread', {
          conversationId,
          nodeId,
          model: model.name,
          errorClass: err instanceof Error ? err.name : typeof err,
        });
        return this.createCompletion({ ...input, codexSession: undefined });
      }
      // A handoff aborts the stream on purpose; only genuine errors propagate.
      if (handoffCalls.length === 0) throw err;
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      await bridge?.close().catch(() => undefined);
      if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Routing tool_calls / final answer — same contract as the Claude adapter:
    // handoff calls surface as tool_calls; a plain answer is only re-emitted
    // when nothing streamed (streamed text would otherwise duplicate in the UI).
    let finalToolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined;
    if (handoffCalls.length > 0) {
      finalToolCalls = handoffCalls.map((h) => ({
        id: `call_${uuidv4()}`,
        type: 'function' as const,
        function: { name: h.name, arguments: JSON.stringify(h.args) },
      }));
    }
    if (finalToolCalls) {
      recordMessage({ role: 'assistant', content: null, tool_calls: finalToolCalls });
    } else if (!streamedText) {
      recordMessage({ role: 'assistant', content: resultText || '' });
    }

    if (sessionTracking) {
      const reusable =
        completedTurn &&
        !failure &&
        !signal?.aborted &&
        handoffCalls.length === 0 &&
        capturedThreadId;
      if (reusable) {
        const stored = recordCodexSession(sessionTracking.key, {
          adapter: sessionTracking.configuration.adapter,
          provider: sessionTracking.configuration.provider,
          threadId: capturedThreadId!,
          configurationHash: sessionTracking.prefixHash,
          prefixHash: sessionTracking.prefixHash,
          seenMessageCount: messages.length + transcript.length,
          historyHash: computeCodexHistoryHash([...messages, ...transcript]),
        });
        onCodexSessionChange?.(stored);
      } else {
        invalidateCodexSession(sessionTracking.key);
        onCodexSessionChange?.(undefined);
      }
      log.debug('Codex SDK thread usage', {
        conversationId,
        nodeId,
        sessionResume: Boolean(sessionResume),
        resumedThisTurn: Boolean(resumeThreadId),
        capturedThread: Boolean(capturedThreadId),
        completedTurn,
        inputMessages: messages.length,
        transcriptMessages: transcript.length,
        watermark: messages.length + transcript.length,
        endedByHandoff: handoffCalls.length > 0,
      });
    }

    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;
    const cachedTokens = usage?.cached_input_tokens ?? 0;

    const completion: OpenAI.Chat.Completions.ChatCompletion = {
      id: `codex_${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.name,
      choices: [
        {
          index: 0,
          finish_reason: finalToolCalls ? 'tool_calls' : 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: resultText || null,
            refusal: null,
            ...(finalToolCalls ? { tool_calls: finalToolCalls } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        // Same fresh/cached split surfaced for the Claude path (#87): the cheap
        // cache RE-READ subset rides in OpenAI's own usage-detail field.
        ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
      },
    };

    return { completion, transcript };
  }
}
