import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import type { ToolDefinition } from '@/backend/execution/flow/types';
import { Model, normalizeMaxTokens } from '@/shared/types/model';
import { isSelfOrchestratingAdapter, resolveModelAdapter } from '@/shared/types/model/provider';
import type { ModelTestAttempt } from '@/shared/types/model/response';
import { getCompletionAdapter } from './adapters';
import { forgetReasoning } from './adapters/openaiResponsesAdapter';
import type { CompletionInput } from './adapters/types';

// Start with an MCP-shaped definition, then use the same schema preparation and
// adapter conversion as real flow tools. Nested/optional fields exercise more
// than a hand-written, parameter-less function would.
const inputSchema = z.object({
  requestId: z.string().uuid(),
  payload: z.object({ values: z.array(z.number().int()).min(1) }),
  note: z.string().optional(),
});
const server = 'flujo-model-test';
const originalName = 'verify_tool_round_trip';
const toolName = encodeToolName(server, originalName);
const definition: ToolDefinition = {
  name: toolName,
  originalName,
  server,
  description: 'Synthetic FLUJO diagnostic tool. Adds the supplied values and returns a receipt. Call once; it has no side effects.',
  inputSchema: z.toJSONSchema(inputSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

/** Exercise schema conversion, tool dispatch, and consumption of the MCP result. */
export async function testModelToolConnection(model: Model, apiKey: string): Promise<ModelTestAttempt> {
  const started = Date.now();
  let stage = 'schema';
  let conversationId: string | undefined;
  try {
    const prepared = ToolHandler.prepareTools({ availableTools: [definition] });
    if (!prepared.success) throw new Error(prepared.error.message);

    const requestId = randomUUID();
    const resolvedAdapter = resolveModelAdapter(model.provider, model.adapter);
    conversationId = resolvedAdapter === 'openai-responses' ? `model-tool-test-${requestId}` : undefined;
    // The receipt is never present in the prompt or schema. A text-only answer
    // cannot pass: the model must receive the actual tool result to learn it.
    let receipt: string | undefined;
    let executionError: Error | undefined;
    const execute = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      stage = 'execution';
      try {
        if (receipt) throw new Error('The diagnostic tool was called more than once.');
        const parsed = inputSchema.parse(args);
        if (parsed.requestId !== requestId) throw new Error('The tool did not receive the requested requestId.');
        if (parsed.payload.values.length !== 2 || parsed.payload.values[0] !== 2 || parsed.payload.values[1] !== 3) {
          throw new Error('The tool did not receive the requested nested values [2, 3].');
        }
        receipt = `flujo-tool-${randomUUID()}`;
        return {
          content: [{ type: 'text', text: JSON.stringify({
            sum: parsed.payload.values.reduce((sum, value) => sum + value, 0),
            receipt,
          }) }],
        };
      } catch (error) {
        executionError = error instanceof Error ? error : new Error(String(error));
        throw executionError;
      }
    };

    const messages: OpenAI.ChatCompletionMessageParam[] = [{
      role: 'user',
      content: `Run the provided FLUJO diagnostic tool exactly once with requestId "${requestId}" and payload {"values":[2,3]}. After receiving its result, reply with only the receipt from that result. Do not invent a receipt or use any other tools.`,
    }];
    const input: CompletionInput = {
      model,
      apiKey,
      conversationId,
      messages,
      tools: prepared.value.tools,
      toolNameMap: { [toolName]: { server, tool: originalName, annotations: definition.annotations } },
      // Claude/Codex wrap this executor in their normal MCP tool bridge and
      // drive the tool loop themselves. HTTP adapters return calls to us below.
      localToolExecutors: { [toolName]: execute },
      maxTokens: normalizeMaxTokens(model.maxTokens),
      maxTurns: 3,
    };
    const adapter = getCompletionAdapter(model);
    stage = 'call';
    let { completion } = await adapter.createCompletion(input);
    let message = completion.choices?.[0]?.message;

    if (!isSelfOrchestratingAdapter(resolvedAdapter)) {
      const calls = message?.tool_calls;
      if (!message || !calls?.length) throw new Error('The model returned text without calling the FLUJO test tool.');
      if (calls.length !== 1) throw new Error('Expected exactly one diagnostic tool call.');
      const call = calls[0];
      if (call.type !== 'function' || call.function.name !== toolName || !call.id) {
        throw new Error('The model returned an unknown tool or an invalid tool-call ID.');
      }
      stage = 'arguments';
      const output = await execute(JSON.parse(call.function.arguments));
      stage = 'result';
      ({ completion } = await adapter.createCompletion({
        ...input,
        messages: [
          ...messages,
          message,
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) },
        ],
      }));
      message = completion.choices?.[0]?.message;
    }

    if (executionError) throw executionError;
    if (!receipt) throw new Error('The FLUJO test tool was never executed.');
    stage = 'result';
    if (message?.tool_calls?.length || !message?.content?.includes(receipt)) {
      throw new Error('The model did not return the receipt from the tool result.');
    }
    return {
      ok: true,
      durationMs: Date.now() - started,
      content: 'FLUJO tool schema accepted, arguments validated, tool executed, and result received by the model.',
      usage: completion.usage as unknown as Record<string, unknown> | undefined,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        code: `tool_test_${stage}_failed`,
      },
    };
  } finally {
    if (conversationId) forgetReasoning(conversationId);
  }
}
