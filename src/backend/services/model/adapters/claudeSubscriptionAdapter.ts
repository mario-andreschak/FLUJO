import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { CompletionAdapter, CompletionInput } from './types';
import { extractText } from './messageUtils';
import { jsonSchemaToZodShape } from './jsonSchemaToZod';

const log = createLogger('backend/services/model/adapters/claudeSubscriptionAdapter');

// Bound the agentic loop when the node doesn't specify its own iteration cap.
const DEFAULT_MAX_TURNS = 10;

// Name of the in-process MCP server we expose FLUJO's tools through. The Agent
// SDK prefixes the model-facing tool names as `mcp__<server>__<tool>`.
const SDK_SERVER_NAME = 'flujo';

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
    // Label turns so multi-turn context survives the flattening.
    prompt = convo
      .map(c => `${c.role === 'assistant' ? 'Assistant' : 'Human'}: ${c.text}`)
      .join('\n\n');
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    prompt,
  };
}

/**
 * Claude Subscription adapter — drives a Claude Pro/Max subscription through the
 * Claude Agent SDK (which wraps the `claude` CLI). Authentication is the OAuth
 * token from `claude setup-token`, supplied per-call via the subprocess `env`
 * (CLAUDE_CODE_OAUTH_TOKEN) so it never mutates this process's environment.
 *
 * Tool calling is agentic: FLUJO's tools are re-exposed to the SDK as an
 * in-process MCP server whose handlers dispatch to `mcpService`, so every tool
 * call still executes inside FLUJO. `canUseTool` is the seam where an
 * interactive approval UI would plug in; for now it auto-approves the node's
 * tools and records them. `maxTurns` bounds the loop.
 *
 * NOTE: the live agentic/tool round-trip requires a real subscription token and
 * an installed `claude` CLI, so it must be verified manually; the pure
 * translation helpers are unit-tested.
 */
export class ClaudeSubscriptionAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    toolNameMap,
    maxTurns,
  }: CompletionInput): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    // Lazy-load the Agent SDK: it ships as ESM, so importing it at module scope
    // would break the (CommonJS) Jest transform for every module that merely
    // references the adapter factory. Loading it here keeps it out of the import
    // graph until a Claude subscription completion actually runs.
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    const { systemPrompt, prompt } = buildPrompt(messages);

    // Build the in-process MCP server from the node's MCP tools. Only tools we
    // can decode to a (server, tool) pair are exposed; handoff/non-MCP tools are
    // omitted (handoffs are FLUJO orchestration, not an in-run agent action).
    const sdkTools = (tools ?? [])
      .filter(t => t.type === 'function')
      .map(t => {
        const decoded = toolNameMap?.[t.function.name];
        if (!decoded) return null;
        const { server, tool: originalTool } = decoded;
        return tool(
          t.function.name,
          t.function.description ?? `${server}: ${originalTool}`,
          jsonSchemaToZodShape(t.function.parameters),
          async (args: Record<string, unknown>): Promise<CallToolResult> => {
            log.debug('Claude subscription tool call', { server, tool: originalTool });
            const result = await mcpService.callTool(server, originalTool, args ?? {});
            if (result.success) {
              return result.data as CallToolResult;
            }
            return {
              content: [{ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` }],
              isError: true,
            };
          }
        );
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const allowedToolNames = sdkTools.map(t => `mcp__${SDK_SERVER_NAME}__${t.name}`);

    const mcpServers = sdkTools.length > 0
      ? { [SDK_SERVER_NAME]: createSdkMcpServer({ name: SDK_SERVER_NAME, version: '1.0.0', tools: sdkTools }) }
      : undefined;

    // Replace the subprocess env wholesale (per SDK contract): inherit ours, add
    // the OAuth token, and drop ANTHROPIC_API_KEY so it can't take precedence
    // over the subscription token.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
    delete childEnv.ANTHROPIC_API_KEY;

    log.debug('createCompletion via Claude Agent SDK', {
      model: model.name,
      toolCount: sdkTools.length,
      hasSystem: Boolean(systemPrompt),
      maxTurns: maxTurns ?? DEFAULT_MAX_TURNS,
    });

    const response = query({
      prompt,
      options: {
        model: model.name,
        env: childEnv,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
        // Replace Claude Code's default agent system prompt with FLUJO's.
        ...(systemPrompt ? { systemPrompt } : {}),
        // Disable all built-in Claude Code tools; only FLUJO's MCP tools apply.
        tools: [],
        ...(mcpServers ? { mcpServers, allowedTools: allowedToolNames } : {}),
        // Auto-approve FLUJO's tools (the future approval-UI seam); deny anything else.
        canUseTool: async (toolName, input) => {
          if (toolName.startsWith(`mcp__${SDK_SERVER_NAME}__`)) {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: `Tool ${toolName} is not permitted for this node.` };
        },
      },
    });

    let resultText = '';
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    for await (const message of response) {
      if (message.type === 'result') {
        usage = message.usage as { input_tokens?: number; output_tokens?: number };
        if (message.subtype === 'success') {
          resultText = message.result;
        } else {
          const detail = 'errors' in message && message.errors?.length
            ? message.errors.join('; ')
            : message.subtype;
          throw new Error(`Claude subscription run failed: ${detail}`);
        }
      }
    }

    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;

    return {
      id: `claude_sub_${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.name,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: resultText || null,
            refusal: null,
          },
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}
