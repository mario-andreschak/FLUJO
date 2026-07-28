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
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { FlujoChatMessage } from '@/shared/types/chat';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { buildUserMessage } from './claudeSubscriptionAdapter';
import { startCodexToolBridge, BridgeTool } from './codexToolBridge';
import { resolveCodexModelCatalogPath } from './codexModelCatalog';
import { prepareCodexRuntimeEnvironment } from './codexRuntimeHome';

const log = createLogger('backend/services/model/adapters/codexAdapter');

// Mirror of the Claude adapter's readable-name scheme: `<server>__<tool>`,
// unique, charset/length-safe. The handler closes over the real (server, tool),
// so the name only has to be stable within the run — not decodable.
const MAX_TOOL_NAME_LEN = 110;

// Local mirror of MAX_DYNAMIC_FANOUT_LANES (SubflowNode) — prep re-caps the
// briefs anyway; this only stops a runaway spawn loop from burning turns.
const MAX_SPAWN_CALLS = 32;

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

interface ToolInteraction {
  id: string;
  name: string;
  argsJson: string;
  resultContent: string;
}

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
 * complete internal-tool allowlist is not available in the SDK, so the thread
 * also runs with `sandboxMode: 'read-only'` in a fresh empty scratch
 * directory; this prevents any remaining built-in edit capability from
 * writing or reaching the network. The loopback MCP bridge is hosted by
 * FLUJO's Node process, so its filesystem tools retain their own FLUJO
 * authorization and are not constrained by the Codex subprocess sandbox.
 * `approvalPolicy: 'never'` keeps the CLI from blocking on interactive
 * shell approval prompts it has no way to deliver. The SDK subprocess also
 * receives a FLUJO-managed CODEX_HOME so personal MCP servers and plugins do
 * not become undeclared tools in a flow run.
 *
 * Like the Claude adapter, `temperature`/`maxTokens` are not applicable (the
 * CLI owns sampling), and `maxTurns` has no SDK knob — the run is bounded by
 * Codex's own turn management. History is always re-flattened per call via
 * buildUserMessage (no session-resume analog of #154 yet; codex threads would
 * support it via thread ids — a future optimization).
 */
export class CodexAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    toolNameMap,
    localToolExecutors,
    requestToolApproval,
    onTranscriptMessage,
    signal,
    conversationId,
    runResourceMarkers,
  }: CompletionInput): Promise<CompletionResult> {
    // Lazy-load the Codex SDK: ESM-only, so a module-scope import would break
    // the CommonJS Jest transform for every module referencing the adapter
    // factory (same reason the Agent SDK is imported lazily).
    const { Codex } = await import('@openai/codex-sdk');

    const { systemPrompt, content } = buildUserMessage(messages, runResourceMarkers);

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
    const recordMessage = (msg: OpenAI.ChatCompletionMessageParam): void => {
      const full = { ...msg, id: `m_${uuidv4()}`, timestamp: baseTs + txSeq++ } as FlujoChatMessage;
      transcript.push(full);
      onTranscriptMessage?.(full);
    };
    const recordToolPair = (ti: ToolInteraction): void => {
      recordMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      });
      recordMessage({ role: 'tool', tool_call_id: ti.id, content: ti.resultContent });
    };

    // Spawn-with-brief bookkeeping (issue #156), mirroring the Claude adapter.
    const handoffCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let endSpawning = false;

    // Approval gate, applied inside every bridge handler before dispatch. On
    // rejection the pair is recorded here (the tool never runs), and the model
    // sees the rejection text as the tool's error result (#247 semantics).
    const gate = async (
      callId: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult | null> => {
      if (!requestToolApproval) return null;
      const { approved, feedback } = await requestToolApproval({ id: callId, name, args });
      if (approved) return null;
      const rejectionText = feedback
        ? `User rejected this tool call: ${feedback}`
        : 'Tool call rejected by the user.';
      recordToolPair({ id: callId, name, argsJson: JSON.stringify(args), resultContent: rejectionText });
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
              recordToolPair({ id: callId, name: fnName, argsJson: JSON.stringify(args ?? {}), resultContent });
              return isError
                ? { content: [{ type: 'text', text: resultContent }], isError: true }
                : { content: [{ type: 'text', text: resultContent }] };
            },
          };
        }

        const { server, tool: originalTool, timeout, nodeId: callerNodeId } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return {
          name: readableName,
          description,
          inputSchema,
          handler: async (args) => {
            const callId = `call_${uuidv4()}`;
            const denied = await gate(callId, readableName, args ?? {});
            if (denied) return denied;
            log.debug('Codex tool call', { server, tool: originalTool, exposedAs: readableName });
            const result = await mcpService.callTool(server, originalTool, args ?? {}, timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS, undefined, callerNodeId);
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
            recordToolPair({ id: callId, name: readableName, argsJson: JSON.stringify(args ?? {}), resultContent });
            return callResult;
          },
        };
      })
      .filter((t): t is BridgeTool => t !== null);

    // Flattened history → Codex stdin input. Keep the system prompt out of
    // Codex SDK config: the SDK serializes config values into CLI arguments,
    // which can exceed Windows' command-line limit for flow-generation prompts.
    // Base64 images from the history are written to scratch files so they can
    // ride along as `local_image` entries (the CLI only takes paths).
    const tempFiles: string[] = [];
    let scratchDir: string | undefined;
    const ensureScratchDir = async (): Promise<string> => {
      if (!scratchDir) scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-'));
      return scratchDir;
    };

    type CodexInputItem = { type: 'text'; text: string } | { type: 'local_image'; path: string };
    const inputItems: CodexInputItem[] = [];
    if (systemPrompt) {
      inputItems.push({
        type: 'text',
        text: `<system_instructions>\n${systemPrompt}\n</system_instructions>`,
      });
    }
    if (typeof content === 'string') {
      inputItems.push({ type: 'text', text: content });
    } else {
      for (const block of content) {
        if (block.type === 'text') {
          inputItems.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          if (block.source.type === 'base64') {
            const dir = await ensureScratchDir();
            const ext = block.source.media_type.split('/')[1] ?? 'png';
            const file = path.join(dir, `img_${tempFiles.length}.${ext}`);
            await fs.writeFile(file, Buffer.from(block.source.data, 'base64'));
            tempFiles.push(file);
            inputItems.push({ type: 'local_image', path: file });
          } else {
            // Remote URLs can't be attached (the CLI reads local paths only);
            // reference them in text so the model at least knows they exist.
            inputItems.push({ type: 'text', text: `[image: ${block.source.url}]` });
          }
        }
      }
    }

    // The working directory for the run: a fresh empty scratch dir, so Codex's
    // built-in read-only shell has nothing project-local to wander through.
    const workingDirectory = await ensureScratchDir();

    let bridge: Awaited<ReturnType<typeof startCodexToolBridge>> | undefined;
    let resultText = '';
    let usage: CodexUsage | undefined;
    let streamedText = false;
    let failure: string | undefined;

    try {
      if (bridgeTools.length > 0) {
        bridge = await startCodexToolBridge(bridgeTools);
      }

      const modelCatalogPath = await resolveCodexModelCatalogPath();
      const runtime = await prepareCodexRuntimeEnvironment(!apiKey);
      const config = {
        // A user's Codex app/CLI Fast-mode preference is global. Do not let a
        // personal `service_tier = "priority"` leak into FLUJO when its selected
        // model (for example gpt-5.4-mini) does not advertise that tier: the CLI
        // completes the turn but exits non-zero after printing the warning.
        service_tier: 'default',
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

      const thread = codex.startThread({
        model: model.name,
        sandboxMode: 'read-only',
        workingDirectory,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
      });

      log.debug('createCompletion via Codex SDK', {
        model: model.name,
        toolCount: bridgeTools.length,
        hasSystem: Boolean(systemPrompt),
        bridged: Boolean(bridge),
        usingLocalModelCatalog: Boolean(modelCatalogPath),
      });

      const { events } = await thread.runStreamed(
        inputItems.length === 1 && inputItems[0].type === 'text' ? inputItems[0].text : inputItems,
        { signal: abortController.signal },
      );

      for await (const event of events) {
        if (signal?.aborted) break;
        // Handoff end conditions (issue #156), mirroring the Claude adapter: a
        // PLAIN handoff ends the run at the next streamed event; SPAWN handoffs
        // end when the model produces a message without another call — or at
        // the runaway cap.
        if (handoffCalls.length > 0 && (endSpawning || handoffCalls.length >= MAX_SPAWN_CALLS)) {
          abortController.abort();
          break;
        }
        if (event.type === 'item.completed') {
          const item = event.item;
          if (item.type === 'agent_message') {
            // A message AFTER spawning means the model stopped queueing
            // workers: end the run without accumulating post-handoff narration.
            if (handoffCalls.length > 0) {
              abortController.abort();
              break;
            }
            if (item.text) {
              resultText += (resultText ? '\n\n' : '') + item.text;
              recordMessage({ role: 'assistant', content: item.text });
              streamedText = true;
            }
          } else if (item.type === 'command_execution') {
            // Codex's built-in shell (read-only sandbox). Surface it in the
            // transcript as a synthetic tool pair so the run's actions are
            // visible in FLUJO instead of vanishing into the subprocess.
            recordToolPair({
              id: `call_${uuidv4()}`,
              name: 'shell',
              argsJson: JSON.stringify({ command: item.command }),
              resultContent: item.aggregated_output ?? '',
            });
          } else if (item.type === 'error') {
            // The SDK classifies ErrorItem as non-fatal. Warnings such as an
            // unsupported optional service tier arrive here even when the MCP
            // call and turn succeed, so only turn.failed may fail the request.
            log.warn('Codex reported a non-fatal item', { message: item.message });
          }
          // mcp_tool_call items are deliberately NOT recorded here — the bridge
          // handlers already record each call/result pair (with approval and
          // bounding applied), so mirroring the item would duplicate them.
        } else if (event.type === 'turn.completed') {
          usage = event.usage as CodexUsage;
        } else if (event.type === 'turn.failed') {
          failure = (event as { error?: { message?: string } }).error?.message ?? 'unknown error';
        }
      }

      if (signal?.aborted && handoffCalls.length === 0) {
        throw new Error('Codex run cancelled by user.');
      }
      if (failure && handoffCalls.length === 0) {
        throw new Error(`Codex run failed: ${failure}`);
      }
    } catch (err) {
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
