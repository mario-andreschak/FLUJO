import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CreateMessageRequestSchema,
  CreateMessageResult,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPSamplingPolicy } from '@/shared/types/mcp';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';

const log = createLogger('backend/services/mcp/sampling');

const DEFAULT_MAX_CALLS_PER_MINUTE = 10;
const DEFAULT_TEMPERATURE = 0.7;

function policyOf(config: MCPServerConfig): MCPSamplingPolicy | undefined {
  return (config as { sampling?: MCPSamplingPolicy }).sampling;
}

/** Sampling is active only when explicitly enabled AND a model is pinned. */
export function samplingEnabled(config: MCPServerConfig): boolean {
  const p = policyOf(config);
  return !!(p?.enabled && p.modelId);
}

/**
 * Stable key of the sampling policy, used (with the roots key) to rebuild the client when
 * the policy changes — the sampling capability is negotiated at connect time.
 */
export function samplingConfigKey(config: MCPServerConfig): string {
  const p = policyOf(config);
  if (!p?.enabled) return '';
  return JSON.stringify({ m: p.modelId, t: p.maxTokens, r: p.maxCallsPerMinute });
}

/**
 * Convert an MCP sampling request (SDK shape) into OpenAI chat messages. The optional
 * systemPrompt becomes a system message. Non-text content (image/audio) is replaced with a
 * placeholder — v1 routes through the text completion path only.
 *
 * NOTE: these messages are UNTRUSTED — they come from the MCP server, not the user. They
 * are passed as plain data to the model on FLUJO's key; they get no special privileges.
 */
function toOpenAiMessages(params: {
  systemPrompt?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
}): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (params.systemPrompt) {
    out.push({ role: 'system', content: params.systemPrompt });
  }
  for (const m of params.messages || []) {
    const content = m.content as { type?: string; text?: string };
    const text =
      content?.type === 'text' && typeof content.text === 'string'
        ? content.text
        : `[unsupported ${content?.type || 'non-text'} content omitted]`;
    out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * Register the `sampling/createMessage` handler so a trusted server can ask FLUJO to run an
 * LLM call (server -> client). Routes through the same completion-adapter seam as the rest
 * of FLUJO, using the model pinned in the server's sampling policy. The spec's per-call
 * human approval is replaced by this design-time trust policy (see MCPSamplingPolicy).
 *
 * Guards: a rolling 60s rate limit (runaway-loop protection) and a pinned model (we ignore
 * the request's modelPreferences in v1 for predictable cost/trust). Only call this when
 * samplingEnabled(config) is true — registering requires the client to declare the
 * sampling capability.
 */
export function registerSamplingHandler(client: Client, config: MCPServerConfig): void {
  // Timestamps of recent sampling calls, for the rolling-window rate limit.
  const recentCalls: number[] = [];

  client.setRequestHandler(CreateMessageRequestSchema, async (request): Promise<CreateMessageResult> => {
    const policy = policyOf(config);
    if (!policy?.enabled || !policy.modelId) {
      throw new McpError(ErrorCode.InvalidRequest, 'Sampling is not enabled for this server');
    }

    // Rolling-window rate limit.
    const limit = policy.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE;
    const now = Date.now();
    const windowStart = now - 60_000;
    while (recentCalls.length > 0 && recentCalls[0] < windowStart) recentCalls.shift();
    if (recentCalls.length >= limit) {
      log.warn(`Sampling rate limit (${limit}/min) hit for ${config.name}`);
      throw new McpError(ErrorCode.InvalidRequest, `Sampling rate limit of ${limit}/min exceeded`);
    }
    recentCalls.push(now);

    const model = await modelService.getModel(policy.modelId);
    if (!model) {
      throw new McpError(ErrorCode.InternalError, `Sampling model not found: ${policy.modelId}`);
    }
    const apiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
    if (!apiKey) {
      throw new McpError(ErrorCode.InternalError, 'Could not resolve the sampling model API key');
    }

    const params = request.params as {
      systemPrompt?: string;
      temperature?: number;
      messages?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    };
    const messages = toOpenAiMessages(params);
    const temperature = typeof params.temperature === 'number' ? params.temperature : DEFAULT_TEMPERATURE;

    log.info(`Sampling for ${config.name} via model ${model.name} (${messages.length} messages)`);
    const adapter = getCompletionAdapter(model);
    const { completion } = await adapter.createCompletion({ model, apiKey, messages, temperature });

    const raw = completion.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw : '';
    return {
      role: 'assistant',
      content: { type: 'text', text },
      model: model.name,
      stopReason: 'endTurn',
    };
  });
}
