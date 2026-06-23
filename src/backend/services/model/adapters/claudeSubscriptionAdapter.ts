import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText } from './messageUtils';
import { jsonSchemaToZodShape } from './jsonSchemaToZod';

const log = createLogger('backend/services/model/adapters/claudeSubscriptionAdapter');

// Bound the agentic loop when the node doesn't specify its own iteration cap.
const DEFAULT_MAX_TURNS = 10;

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
 * Flatten FLUJO's OpenAI-format messages for the Agent SDK, which takes a single
 * `systemPrompt` plus a `prompt`. System messages are hoisted; the remaining
 * user/assistant turns are rendered into the prompt. Tool-role messages are
 * dropped — in this adapter Claude runs the tool loop itself, so prior
 * FLUJO-side tool exchanges aren't replayed.
 */
function buildPrompt(messages: OpenAI.ChatCompletionMessageParam[]): {
  systemPrompt?: string;
  prompt: string;
} {
  const systemParts: string[] = [];
  const convo: Array<{ role: 'user' | 'assistant'; text: string }> = [];

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
  }

  let prompt: string;
  if (convo.length <= 1) {
    prompt = convo[0]?.text ?? '';
  } else {
    prompt = convo
      .map(c => `${c.role === 'assistant' ? 'Assistant' : 'Human'}: ${c.text}`)
      .join('\n\n');
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    prompt,
  };
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
 * parsing the SDK's streamed messages, and replay them into the conversation as
 * a `transcript`. Handoff tools are exposed too: invoking one records the handoff
 * and aborts the run, surfacing it as a tool_call so FLUJO's edge routing fires.
 * `canUseTool` auto-approves FLUJO's tools (the seam for an interactive approval
 * UI); `maxTurns` bounds the loop.
 *
 * NOTE: the live agentic/tool round-trip requires a real subscription token and
 * an installed `claude` CLI; the pure translation helpers are unit-tested.
 */
export class ClaudeSubscriptionAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    toolNameMap,
    maxTurns,
    requestToolApproval,
  }: CompletionInput): Promise<CompletionResult> {
    // Lazy-load the Agent SDK: it ships as ESM, so importing it at module scope
    // would break the (CommonJS) Jest transform for every module that merely
    // references the adapter factory.
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    const { systemPrompt, prompt } = buildPrompt(messages);

    const usedNames = new Set<string>();
    const toolInteractions: ToolInteraction[] = [];
    let handoffCall: { name: string; args: Record<string, unknown> } | null = null;
    const abortController = new AbortController();

    // Build the in-process MCP server from the node's tools. MCP tools dispatch to
    // mcpService; handoff tools record the handoff and abort. Other tool kinds
    // (external/passthrough) are omitted from an agentic run.
    const sdkTools = (tools ?? [])
      .filter(t => t.type === 'function')
      .map(t => {
        const fnName = t.function.name;
        const handoff = isHandoffName(fnName);
        const decoded = toolNameMap?.[fnName];
        if (!handoff && !decoded) return null;

        const description = t.function.description ?? '';
        const schemaShape = jsonSchemaToZodShape(t.function.parameters);

        if (handoff) {
          // Keep the exact name so FLUJO's `handoff_to_<nodeId>` routing matches.
          return tool(fnName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            handoffCall = { name: fnName, args: args ?? {} };
            log.debug('Claude subscription requested handoff', { tool: fnName });
            abortController.abort();
            return { content: [{ type: 'text', text: 'Handing off.' }] };
          });
        }

        const { server, tool: originalTool } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return tool(readableName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
          log.debug('Claude subscription tool call', { server, tool: originalTool, exposedAs: readableName });
          const result = await mcpService.callTool(server, originalTool, args ?? {});
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
          toolInteractions.push({
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

    log.debug('createCompletion via Claude Agent SDK', {
      model: model.name,
      toolCount: sdkTools.length,
      hasSystem: Boolean(systemPrompt),
      maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
    });

    const response = query({
      prompt,
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
            toolInteractions.push({
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
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    try {
      for await (const message of response) {
        if (message.type === 'assistant') {
          const content = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') accumulatedText += block.text;
            }
          }
        } else if (message.type === 'result') {
          usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
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
    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;

    // Replay the in-process tool calls into the conversation: one assistant
    // (tool_call) + tool (result) pair each, in call order.
    const transcript: OpenAI.ChatCompletionMessageParam[] = [];
    for (const ti of toolInteractions) {
      transcript.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      });
      transcript.push({ role: 'tool', tool_call_id: ti.id, content: ti.resultContent });
    }

    // The final assistant turn: a handoff tool_call (for routing) or plain text.
    let finalToolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined;
    if (handoffCall) {
      const h = handoffCall as { name: string; args: Record<string, unknown> };
      finalToolCalls = [
        { id: `call_${uuidv4()}`, type: 'function', function: { name: h.name, arguments: JSON.stringify(h.args) } },
      ];
    }
    transcript.push({
      role: 'assistant',
      content: finalText || (finalToolCalls ? null : ''),
      ...(finalToolCalls ? { tool_calls: finalToolCalls } : {}),
    });

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
      },
    };

    return { completion, transcript };
  }
}
