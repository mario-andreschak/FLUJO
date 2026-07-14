import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// Type-only imports (erased at compile time, so they don't trigger the ESM
// runtime-load issue that forces the Agent SDK itself to be imported lazily).
import type Anthropic from '@anthropic-ai/sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { FlujoChatMessage } from '@/shared/types/chat';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText, extractImageParts, toAnthropicImageMediaType } from './messageUtils';
import { jsonSchemaToZodShape } from './jsonSchemaToZod';
import { mapSdkUsage, type SdkUsage } from './claudeUsage';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';

const log = createLogger('backend/services/model/adapters/claudeSubscriptionAdapter');

// Bound the agentic loop when the caller doesn't specify a cap. Aligned with the
// system default so behaviour is consistent whether or not maxTurns is threaded.
// In practice ModelHandler always resolves and passes a positive maxTurns, so
// this fallback is only a safety net.
const DEFAULT_MAX_TURNS = DEFAULT_AGENTIC_MAX_TURNS;

// Name of the in-process MCP server we expose FLUJO's tools through. The Agent
// SDK prefixes the model-facing tool names as `mcp__<server>__<tool>`.
const SDK_SERVER_NAME = 'flujo';

// Keep tool names under Anthropic's 128-char limit with room for the
// `mcp__flujo__` prefix the SDK adds.
const MAX_TOOL_NAME_LEN = 110;

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build a readable, collision-free `<server>__<tool>` name for a tool exposed to
 * Claude. Unlike FLUJO's hashed model-facing names, this is human-readable in the
 * conversation; the handler closes over the real (server, tool), so the name only
 * has to be unique and charset/length-safe — not decodable.
 */
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

/**
 * Flatten FLUJO's OpenAI-format messages into the Agent SDK's structured input:
 * a hoisted `systemPrompt` plus the content for a single streamed user message.
 * System messages are hoisted; the remaining user/assistant turns are rendered
 * into one text block (the SDK is driven with a single user message, so prior
 * assistant turns are replayed as text rather than as distinct turns). Images
 * from user turns become image content blocks so a vision-capable Claude can
 * see them. Tool-role messages are dropped — Claude runs the tool loop itself
 * here, so prior FLUJO-side tool exchanges aren't replayed.
 *
 * When there are no images the content is a plain string — byte-for-byte the
 * prompt the old flat-string path produced — so non-image runs are unchanged;
 * only the delivery channel (streaming input) differs.
 *
 * KNOWN LIMITATION (#87) — quadratic re-send: every node call spawns a fresh
 * `query()` (a new `claude` subprocess, no `resume`/`session_id`) and re-sends
 * the ENTIRE prior conversation flattened here. Only `systemPrompt` + tool defs
 * form a cacheable prefix; the conversation body is re-tokenized each turn, so
 * cumulative input grows ~O(n^2) with conversation length. The reporting side of
 * this was fixed by surfacing cache RE-READ tokens separately (see claudeUsage
 * .ts) so warmed-cache reads stop inflating the headline. The efficiency side
 * — reusing the SDK session per conversation via `resume` + a persisted
 * `session_id` and sending only the per-turn delta — is a larger, separate
 * change (needs per-(conversation,node) session keying because each node has
 * its own systemPrompt/tool set, plus reconciliation with client-side history
 * pruning and handoff "clean conversation" semantics) and is deliberately left
 * as a follow-up; this flatten path remains the documented fallback.
 */
export function buildUserMessage(messages: OpenAI.ChatCompletionMessageParam[]): {
  systemPrompt?: string;
  content: string | Anthropic.ContentBlockParam[];
} {
  const systemParts: string[] = [];
  const convo: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const images: ReturnType<typeof extractImageParts> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const text = extractText(msg.content ?? '');
    if (text) convo.push({ role: msg.role, text });
    if (msg.role === 'user') images.push(...extractImageParts(msg.content));
  }

  const promptText =
    convo.length <= 1
      ? convo[0]?.text ?? ''
      : convo.map(c => `${c.role === 'assistant' ? 'Assistant' : 'Human'}: ${c.text}`).join('\n\n');

  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  if (images.length === 0) {
    return { systemPrompt, content: promptText };
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (promptText) blocks.push({ type: 'text', text: promptText });
  for (const img of images) {
    if (img.base64) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: toAnthropicImageMediaType(img.mimeType), data: img.base64 },
      });
    } else {
      blocks.push({ type: 'image', source: { type: 'url', url: img.url } });
    }
  }
  return { systemPrompt, content: blocks };
}

interface ToolInteraction {
  id: string;
  name: string;
  argsJson: string;
  resultContent: string;
}

/**
 * Claude Subscription adapter — drives a Claude Pro/Max subscription through the
 * Claude Agent SDK (which wraps the `claude` CLI). Authentication is the OAuth
 * token from `claude setup-token`, supplied per-call via the subprocess `env`
 * (CLAUDE_CODE_OAUTH_TOKEN).
 *
 * Tool calling is agentic. FLUJO's tools are re-exposed to the SDK as an
 * in-process MCP server whose handlers dispatch to `mcpService` — so every tool
 * call executes AND is observed inside FLUJO. Because the calls route through our
 * own handlers, we capture each call + result there (structured) rather than
 * parsing the SDK's streamed messages. Each captured assistant/tool message is
 * BOTH streamed live (via `onTranscriptMessage`, so the UI sees tool calls as
 * they happen instead of an hour later) AND collected into the returned
 * `transcript` for persistence. Handoff tools are exposed too: invoking one records the handoff
 * and aborts the run, surfacing it as a tool_call so FLUJO's edge routing fires.
 * `canUseTool` auto-approves FLUJO's tools (the seam for an interactive approval
 * UI); `maxTurns` bounds the loop.
 *
 * Input is delivered through the SDK's streaming-input channel (an
 * `AsyncIterable<SDKUserMessage>`) rather than a flat string prompt, so a
 * multimodal user turn can carry image content blocks alongside its text.
 */
export class ClaudeSubscriptionAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    toolNameMap,
    localToolExecutors,
    maxTurns,
    requestToolApproval,
    onTranscriptMessage,
  }: CompletionInput): Promise<CompletionResult> {
    // Lazy-load the Agent SDK: it ships as ESM, so importing it at module scope
    // would break the (CommonJS) Jest transform for every module that merely
    // references the adapter factory.
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    const { systemPrompt, content: userContent } = buildUserMessage(messages);

    const usedNames = new Set<string>();
    let handoffCall: { name: string; args: Record<string, unknown> } | null = null;
    const abortController = new AbortController();

    // The conversation messages produced by this run, in order. Each is given a
    // stable id and streamed live as it is recorded; the same array is returned
    // as the transcript so the caller can persist (and re-emit) them with
    // matching ids. `txSeq` keeps timestamps monotonic within the run.
    const transcript: FlujoChatMessage[] = [];
    const baseTs = Date.now();
    let txSeq = 0;
    const recordMessage = (msg: OpenAI.ChatCompletionMessageParam): void => {
      const full = { ...msg, id: `m_${uuidv4()}`, timestamp: baseTs + txSeq++ } as FlujoChatMessage;
      transcript.push(full);
      onTranscriptMessage?.(full);
    };
    // Materialize an executed (or rejected) tool call as the OpenAI-shaped
    // assistant(tool_call) + tool(result) pair, streaming both live.
    const recordToolPair = (ti: ToolInteraction): void => {
      recordMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      });
      recordMessage({ role: 'tool', tool_call_id: ti.id, content: ti.resultContent });
    };

    // Build the in-process MCP server from the node's tools. MCP tools dispatch to
    // mcpService; handoff tools record the handoff and abort; caller-defined local
    // tools (e.g. the flow generator's marketplace search/install) dispatch to the
    // executor supplied via localToolExecutors. Anything else is omitted from an
    // agentic run.
    const sdkTools = (tools ?? [])
      .filter(t => t.type === 'function')
      .map(t => {
        const fnName = t.function.name;
        const handoff = isHandoffName(fnName);
        const decoded = toolNameMap?.[fnName];
        const localExec = localToolExecutors?.[fnName];
        if (!handoff && !decoded && !localExec) return null;

        const description = t.function.description ?? '';
        const schemaShape = jsonSchemaToZodShape(t.function.parameters);

        if (handoff) {
          // Keep the exact name so FLUJO's `handoff_to_<nodeId>` routing matches.
          return tool(fnName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            // A model can emit several tool_uses in one turn; only the first
            // handoff counts. Ignoring the rest also avoids re-aborting.
            if (handoffCall) {
              return { content: [{ type: 'text', text: 'Already handing off.' }] };
            }
            handoffCall = { name: fnName, args: args ?? {} };
            log.debug('Claude subscription requested handoff', { tool: fnName });
            // Do NOT abort here. Aborting inside the tool handler tears down the
            // SDK control stream mid-permission-round-trip and surfaces the
            // benign "permission stream closed" error. Instead just record the
            // handoff and return cleanly; the message loop aborts on its next
            // turn (see the handoffCall check at the top of the for-await).
            return { content: [{ type: 'text', text: 'Handing off.' }] };
          });
        }

        if (localExec) {
          // Caller-executed virtual tool: run the supplied executor in-loop and
          // hand its JSON result back to the SDK. Keep the exact name — these
          // names are already OpenAI-safe and the caller keys executors by them.
          return tool(fnName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            log.debug('Claude subscription local tool call', { tool: fnName });
            let resultContent: string;
            let isError = false;
            try {
              resultContent = JSON.stringify(await localExec(args ?? {}));
            } catch (err) {
              resultContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
            recordToolPair({
              id: `call_${uuidv4()}`,
              name: fnName,
              argsJson: JSON.stringify(args ?? {}),
              resultContent,
            });
            return isError
              ? { content: [{ type: 'text', text: resultContent }], isError: true }
              : { content: [{ type: 'text', text: resultContent }] };
          });
        }

        const { server, tool: originalTool, timeout } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return tool(readableName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
          log.debug('Claude subscription tool call', { server, tool: originalTool, exposedAs: readableName });
          // Same timeout policy as the OpenAI-path tool loop: the MCP node's
          // toolTimeout (seconds, -1 = none), defaulting to 5 minutes.
          const result = await mcpService.callTool(server, originalTool, args ?? {}, timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS);
          let callResult: CallToolResult;
          let resultContent: string;
          if (result.success) {
            callResult = result.data as CallToolResult;
            // Match the OpenAI path's tool-result encoding (JSON of the result data).
            resultContent = JSON.stringify(result.data);
          } else {
            resultContent = `Error: ${result.error ?? 'Unknown error'}`;
            callResult = { content: [{ type: 'text', text: resultContent }], isError: true };
          }
          recordToolPair({
            id: `call_${uuidv4()}`,
            name: readableName,
            argsJson: JSON.stringify(args ?? {}),
            resultContent,
          });
          return callResult;
        });
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const mcpServers = sdkTools.length > 0
      ? { [SDK_SERVER_NAME]: createSdkMcpServer({ name: SDK_SERVER_NAME, version: '1.0.0', tools: sdkTools }) }
      : undefined;

    // Replace the subprocess env wholesale (per SDK contract): inherit ours, add
    // the OAuth token, and drop ANTHROPIC_API_KEY so it can't take precedence.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
    delete childEnv.ANTHROPIC_API_KEY;

    const hasImages = typeof userContent !== 'string';
    log.debug('createCompletion via Claude Agent SDK', {
      model: model.name,
      toolCount: sdkTools.length,
      hasSystem: Boolean(systemPrompt),
      hasImages,
      maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
    });

    // Drive the SDK via its streaming-input channel with a single user message.
    // The generator yields once then completes, signaling end-of-input so the
    // SDK processes the turn (and runs the agentic tool loop) to completion.
    async function* promptStream(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: userContent },
      };
    }

    const response = query({
      prompt: promptStream(),
      options: {
        model: model.name,
        env: childEnv,
        abortController,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
        ...(systemPrompt ? { systemPrompt } : {}),
        tools: [], // disable Claude's built-in tools; only FLUJO's MCP tools apply
        // NOTE: deliberately NOT setting `allowedTools` — entries there are
        // auto-allowed and BYPASS canUseTool, which would skip the approval gate.
        // canUseTool is the sole authority: it auto-allows our tools when no gate
        // is wired, and blocks for approval when it is.
        ...(mcpServers ? { mcpServers } : {}),
        canUseTool: async (toolName, input, opts) => {
          if (!toolName.startsWith(`mcp__${SDK_SERVER_NAME}__`)) {
            return { behavior: 'deny', message: `Tool ${toolName} is not permitted for this node.` };
          }
          // Human-in-the-loop: when an approval gate is wired, block until the
          // user decides (surfaced to FLUJO's tool-approval UI). Otherwise auto-allow.
          if (requestToolApproval) {
            const readableName = toolName.replace(`mcp__${SDK_SERVER_NAME}__`, '');
            const approved = await requestToolApproval({
              id: opts.toolUseID,
              name: readableName,
              args: (input ?? {}) as Record<string, unknown>,
            });
            if (approved) {
              return { behavior: 'allow', updatedInput: input };
            }
            // On rejection the SDK never calls the tool handler, so record the
            // rejected call here — otherwise it (and the rejection) wouldn't show
            // up in the conversation transcript at all.
            recordToolPair({
              id: opts.toolUseID,
              name: readableName,
              argsJson: JSON.stringify(input ?? {}),
              resultContent: 'Tool call rejected by the user.',
            });
            return { behavior: 'deny', message: 'Tool call rejected by the user.' };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    let resultText = '';
    let accumulatedText = '';
    // Token accounting. The SDK's terminal `result` message carries the run's
    // usage, but a handoff ABORTS the loop before that message arrives — so we
    // also track per-turn usage from each assistant message as a fallback
    // (otherwise every run that ends by routing to another node reports 0
    // tokens). The fresh/cached split is computed by mapSdkUsage (see
    // claudeUsage.ts and issue #87): promptTokens is the full input context,
    // but the cheap cache RE-READ tokens are also surfaced separately so the UI
    // doesn't count them as fresh on every turn.
    let usage: SdkUsage | undefined;
    let lastTurnUsage: SdkUsage | undefined;
    let totalOutputTokens = 0;
    // Whether we streamed at least one assistant text turn live (below). If so,
    // the final answer is already in the transcript and we must not re-emit the
    // concatenated text at the end (it would duplicate in the UI).
    let streamedText = false;

    try {
      for await (const message of response) {
        // A handoff was requested by the tool handler (which runs between the
        // assistant turn that called it and the next turn). Stop here — BEFORE
        // accumulating any further turn — so the model can't narrate post-handoff
        // (e.g. the benign abort-race "permission stream closed" message), while
        // the handoff turn's own text (already in accumulatedText) is preserved.
        if (handoffCall) {
          abortController.abort();
          break;
        }
        if (message.type === 'assistant') {
          const assistant = (message as { message?: { content?: unknown; usage?: SdkUsage } }).message;
          const content = assistant?.content;
          let turnText = '';
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') turnText += block.text;
            }
          }
          if (turnText) {
            accumulatedText += turnText;
            // Stream THIS turn's narration live as its own assistant message, so
            // the UI shows Claude's step-by-step reasoning interleaved with the
            // tool calls (which already stream via recordToolPair) instead of
            // arriving as one block after the whole (possibly long) run. Text
            // blocks precede tool_use within a turn, so this lands in the right
            // order: turn text -> tool pair -> next turn text -> ...
            recordMessage({ role: 'assistant', content: turnText });
            streamedText = true;
          }
          if (assistant?.usage) {
            lastTurnUsage = assistant.usage;
            totalOutputTokens += assistant.usage.output_tokens ?? 0;
          }
        } else if (message.type === 'result') {
          usage = (message as { usage?: SdkUsage }).usage;
          if (message.subtype === 'success') {
            resultText = (message as { result?: string }).result ?? '';
          } else if (!handoffCall) {
            const errs = (message as { errors?: string[] }).errors;
            const detail = Array.isArray(errs) && errs.length ? errs.join('; ') : message.subtype;
            throw new Error(`Claude subscription run failed: ${detail}`);
          }
        }
      }
    } catch (err) {
      // A handoff aborts the run on purpose; only genuine errors propagate.
      if (!handoffCall) throw err;
    }

    const finalText = resultText || accumulatedText;
    // Prefer the result message's totals; on handoff-aborted runs fall back to
    // the last turn's context size + the summed output of all turns. cacheRead
    // is the prefix re-read cheaply from the prompt cache — kept out of the
    // "fresh" headline so a warmed-cache conversation stops reporting millions.
    const { promptTokens, completionTokens, cacheReadTokens } = mapSdkUsage(usage, {
      lastTurnUsage,
      totalOutputTokens,
    });

    // The per-tool assistant(tool_call)+tool(result) pairs, and now each turn's
    // narration text, were already recorded and streamed live as they happened
    // (see recordToolPair and the `assistant` branch above). So here we only add
    // what is NOT yet in the transcript:
    //   - a handoff tool_call (routing), with content null since the handoff
    //     turn's text — a node can legitimately answer AND hand off in one turn —
    //     already streamed above; the node's output is still `finalText` (below),
    //     which createCompletion returns separately from the transcript.
    //   - a plain-text answer ONLY when nothing streamed (e.g. the run produced
    //     no assistant text turns and only the terminal `result` carried text).
    // Re-emitting `finalText` when we already streamed it would duplicate it.
    let finalToolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined;
    if (handoffCall) {
      const h = handoffCall as { name: string; args: Record<string, unknown> };
      finalToolCalls = [
        { id: `call_${uuidv4()}`, type: 'function', function: { name: h.name, arguments: JSON.stringify(h.args) } },
      ];
    }
    if (finalToolCalls) {
      recordMessage({ role: 'assistant', content: null, tool_calls: finalToolCalls });
    } else if (!streamedText) {
      recordMessage({ role: 'assistant', content: finalText || '' });
    }

    const completion: OpenAI.Chat.Completions.ChatCompletion = {
      id: `claude_sub_${uuidv4()}`,
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
            content: finalText || null,
            refusal: null,
            ...(finalToolCalls ? { tool_calls: finalToolCalls } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        // Surface the cheap cache RE-READ subset via OpenAI's own usage detail
        // field so downstream (ModelHandler → usage totals → UI) can present a
        // "fresh (+cached)" split instead of one inflated number (#87).
        ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
      },
    };

    return { completion, transcript };
  }
}
