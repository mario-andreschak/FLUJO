import { createLogger, LOG_LEVEL } from '@/utils/logger';
import {
  ModelCallInput,
  ModelCallResult,
  ToolCallProcessingInput,
  ToolCallProcessingResult
} from '../types/modelHandler';
import { ToolCallInfo } from '../types'; // Import ToolCallInfo
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path for FlujoChatMessage
import { Result, ExecutionError } from '../errors';
import { createModelError, createToolError } from '../errorFactory';
import { decodeToolName } from './toolNamespace';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mcpService } from '@/backend/services/mcp';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

const log = createLogger('backend/flow/execution/handlers/ModelHandler'
  // , LOG_LEVEL.VERBOSE // override for the current file
);

export class ModelHandler {
  /**
   * Normalize a provider error body into a detailed, human-readable message
   * plus structured detail fields.
   *
   * The same provider error shape reaches us two ways: when the provider
   * returns HTTP 200 with an `error` object in the body, and when the SDK
   * throws an `OpenAI.APIError` (whose `.error` is that same body). Both paths
   * call this so the extraction stays consistent. OpenRouter in particular
   * nests the real upstream reason under `metadata` — `raw` is usually a plain
   * human-readable string (occasionally a JSON string), and `provider_name` /
   * `retry_after_seconds` are the actionable bits.
   *
   * @param body       The provider error object (chatCompletion.error or APIError.error).
   * @param baseMessage Optional prefix (e.g. the SDK's "429 ..." message) to build on.
   */
  private static extractProviderErrorDetails(
    body: any,
    baseMessage?: string
  ): {
    message: string;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    retryAfter?: string;
    providerError?: unknown;
  } {
    let message =
      baseMessage || body?.message || 'Provider returned an unspecified error in the response body.';

    // When a base message is supplied (SDK path), append the body's own message
    // if it adds something beyond the prefix.
    if (
      baseMessage &&
      typeof body?.message === 'string' &&
      body.message &&
      body.message !== baseMessage
    ) {
      message = `${baseMessage} - ${body.message}`;
    }

    const meta = body?.metadata;
    if (meta) {
      let rawMsg: string | undefined;
      if (typeof meta.raw === 'string') {
        try {
          const parsed = JSON.parse(meta.raw);
          rawMsg = parsed?.error?.message || parsed?.message || meta.raw;
        } catch {
          rawMsg = meta.raw; // not JSON — use the string as-is
        }
      } else if (meta.raw && typeof meta.raw === 'object') {
        rawMsg = meta.raw.error?.message || meta.raw.message;
      }
      const upstreamParts: string[] = [];
      if (meta.provider_name) upstreamParts.push(String(meta.provider_name));
      if (rawMsg) upstreamParts.push(rawMsg);
      if (upstreamParts.length > 0) {
        message = `${message} (upstream: ${upstreamParts.join(': ')})`;
      }
    }

    return {
      message,
      code: body?.code,
      type: body?.type,
      param: body?.param,
      retryAfter: meta?.retry_after_seconds != null ? String(meta.retry_after_seconds) : undefined,
      providerError: body,
    };
  }

  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, tools, nodeName, nodeId, toolNameMap, maxIterations } = input; // Added nodeId

    // Fetch model information for display name
    let modelDisplayName = '';
    let modelTechnicalName = '';
    const nodeDisplayName = nodeName;
    try {
      const model = await modelService.getModel(modelId);
      if (model) {
        modelDisplayName = model.displayName || model.name;
        modelTechnicalName = model.name;
      }
    } catch (error) {
      log.warn(`Failed to fetch model information for prefix: ${error instanceof Error ? error.message : String(error)}`);
    }

    log.info(`callModel - Single execution`, {
      modelId,
      messagesCount: messages.length,
      toolsCount: tools?.length || 0,
      nodeName,
      nodeId // Log nodeId
    });

    // Add verbose logging of the entire input
    log.verbose('callModel input', JSON.stringify(input));

    // Call generateCompletion ONCE
    const response = await this.generateCompletion(modelId, prompt, messages, tools, { toolNameMap, maxTurns: maxIterations });

    if (!response.success) {
      // Add verbose logging of the error response
      log.verbose('callModel error response', JSON.stringify(response));

      // Ensure we're returning the complete error response with all details
      return {
        success: false,
        error: response.error
      };
    }

    const modelResponse = response.value;
    const content = modelResponse.content || '';
    const finalMessages: FlujoChatMessage[] = [...messages]; // Start with input messages (already FlujoChatMessage)

    // // Check if content already starts with a heading pattern like "## ... says:"
    // const hasHeadingPattern = /^## .+says:\s*\n\n/i.test(content);
    
    // // Format content with prefix only if it doesn't already have a heading pattern
    // const prefixedContent = modelDisplayName && !hasHeadingPattern
    //   ? `## ${nodeDisplayName} - ${modelDisplayName} (${modelTechnicalName}) says:\n\n${content}`
    //   : content;
    
    const prefixedContent = content;

    // Extract provider-reported token usage, if present, so the UI can show
    // per-message and aggregated token/cost figures.
    const rawUsage = modelResponse.fullResponse?.usage;
    const usage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : undefined;

    // Create the assistant message with timestamp and ID
    const assistantMessage: FlujoChatMessage = {
      id: uuidv4(), // Generate unique ID
      role: 'assistant',
      content: prefixedContent,
      // IMPORTANT: Include tool_calls if they exist in the raw response
      tool_calls: modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls,
      timestamp: Date.now(), // Add timestamp
      processNodeId: nodeId, // Attach the process node ID
      ...(usage ? { usage } : {}),
    };
    finalMessages.push(assistantMessage);

    // Map tool calls for the result structure (if they exist)
    // This provides structured info about requested calls, but doesn't execute them
    const toolCalls = modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls?.map((tc: OpenAI.ChatCompletionMessageToolCall) => { // Add type annotation for tc
       try {
         return {
           name: tc.function.name,
           args: JSON.parse(tc.function.arguments),
           id: tc.id,
           result: '' // Result is empty as it's not processed here
         };
       } catch (e) {
         log.warn(`Failed to parse tool arguments for call ${tc.id}`, { args: tc.function.arguments, error: e });
         return {
           name: tc.function.name,
           args: {}, // Use empty object on parse failure
           id: tc.id,
           result: ''
         };
       }
    }).filter(Boolean) as ToolCallInfo[] | undefined; // Ensure type safety and filter out potential nulls if parse fails badly


    // Return the result of this single step
    const result: Result<ModelCallResult> = {
      success: true,
      value: {
        content: typeof assistantMessage.content === 'string' ? assistantMessage.content : content, // Use prefixed content
        messages: finalMessages, // Include the new assistant message (now FlujoChatMessage[])
        fullResponse: modelResponse.fullResponse,
        toolCalls // Pass the structured tool calls info
      }
    };

    log.verbose('callModel single step result', JSON.stringify(result));
    return result;
  }



  /**
   * Generate completion using model service - pure function
   */
  private static async generateCompletion(
    modelId: string,
    prompt: string,
    messages: FlujoChatMessage[], // Expect FlujoChatMessage
    tools?: OpenAI.ChatCompletionTool[],
    opts?: {
      toolNameMap?: Record<string, { server: string; tool: string }>;
      maxTurns?: number;
    }
  ): Promise<Result<ModelCallResult>> {
    // Add verbose logging of the input parameters
    log.verbose('generateCompletion input', JSON.stringify({
      modelId,
      prompt,
      messages,
      tools
    }));
    try {
      // Get the model
      const model = await modelService.getModel(modelId);
      if (!model) {
        return {
          success: false,
          error: createModelError(
            'model_not_found',
            `Model not found: ${modelId}`,
            modelId
          )
        };
      }

      // Extract model settings
      const temperature = model.temperature ? parseFloat(model.temperature) : 0.0;

      // Resolve and decrypt the API key
      const decryptedApiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
      if (!decryptedApiKey) {
        return {
          success: false,
          error: createModelError(
            'api_key_error',
            'Failed to resolve or decrypt API key',
            modelId
          )
        };
      }
      log.verbose(`decrypted api key ${decryptedApiKey}`)
      log.verbose(` baseurl ${model.baseUrl}`)

      // Create the request parameters - the adapters expect ChatCompletionMessageParam,
      // not FlujoChatMessage, so strip the FLUJO-internal timestamp before sending.
      const apiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map(({ timestamp, ...rest }) => rest);

      // Sanitize tool schemas for broad provider compatibility (handles string
      // properties with unsupported `format` values, etc.). Done once here so
      // every adapter receives clean tool definitions.
      let sanitizedTools: OpenAI.ChatCompletionTool[] | undefined;
      if (tools && tools.length > 0) {
        const { ToolHandler } = require('../handlers/ToolHandler');
        sanitizedTools = tools.map(tool => {
          if (tool.type === 'function' && tool.function.parameters) {
            return {
              ...tool,
              function: {
                ...tool.function,
                parameters: ToolHandler.sanitizeSchema(tool.function.parameters)
              }
            };
          }
          return tool;
        });
      }

      // Select the completion adapter for this model's provider/SDK. The
      // OpenAI-compatible adapter wraps the original hardened-client path; the
      // native adapters (Anthropic, Gemini, Claude CLI) translate to/from their
      // own APIs but return the same OpenAI-shaped response, so everything below
      // is provider-agnostic.
      const adapter = getCompletionAdapter(model);

      log.debug(`calling chatcompletion`)
      log.verbose(`calling chatcompletion now with ADAPTER ${JSON.stringify(model.adapter || 'openai')}`)
      log.verbose(`calling chatcompletion now with MODEL ${ JSON.stringify(model.name)}`)
      log.verbose(`calling chatcompletion now with TEMP ${ JSON.stringify(temperature)}`)
      log.verbose(`calling chatcompletion now with MESSAGES ${ JSON.stringify(apiMessages)}`)
      log.verbose(`calling chatcompletion now with TOOLS ${ JSON.stringify(sanitizedTools)}`)

      // --- Log the exact request being sent ---
      log.debug('[ModelHandler.generateCompletion] Sending request via adapter', { adapter: model.adapter || 'openai', model: model.name });

      // Make the API request through the selected adapter.
      const chatCompletion = await adapter.createCompletion({
        model,
        apiKey: decryptedApiKey,
        messages: apiMessages,
        tools: sanitizedTools,
        temperature,
        toolNameMap: opts?.toolNameMap,
        maxTurns: opts?.maxTurns,
      });

      // --- Log the raw response received ---
      log.debug('[ModelHandler.generateCompletion] Received raw response from OpenAI API', { response: JSON.stringify(chatCompletion) }); // Use debug level

      log.verbose(`chatcompletion returned`) // Keep verbose for backward compatibility if needed
      log.verbose(`chatcompletion returned ${ JSON.stringify(chatCompletion)}`) // Keep verbose

      // --- Check for top-level error in the response ---
      // Some providers (like OpenRouter for certain errors) might return a 200 OK
      // with an error object in the body instead of throwing an HTTP error.
      if (chatCompletion && typeof chatCompletion === 'object' && 'error' in chatCompletion && chatCompletion.error) {
        log.warn('API call returned successfully but contained an error object:', JSON.stringify(chatCompletion.error));
        const errorObj = chatCompletion.error as any; // Type assertion for easier access

        // Shape the message + details consistently with the thrown-error path.
        const extracted = ModelHandler.extractProviderErrorDetails(errorObj);

        const errorResult: Result<ModelCallResult> = {
            success: false,
            error: createModelError(
                'api_error', // Treat as API error
                extracted.message,
                modelId,
                undefined,
                {
                    code: extracted.code,
                    type: extracted.type,
                    param: extracted.param,
                    retryAfter: extracted.retryAfter,
                    // The full parsed provider body is the richest source of truth.
                    providerError: extracted.providerError,
                }
            )
        };
        log.verbose('generateCompletion returning error from response body', JSON.stringify(errorResult));
        return errorResult;
      }
      // --- End error check ---


      // Create a standardized response with OpenAI-compatible structure
      // Ensure choices exist before accessing them
      const choice = chatCompletion?.choices?.[0];
      if (!choice) {
        log.error('API response missing choices array or first choice.', { response: JSON.stringify(chatCompletion) });
        return {
          success: false,
          error: createModelError(
            'api_error',
            'Invalid response structure from API: Missing choices.',
            modelId,
            undefined,
            { rawResponse: chatCompletion }
          )
        };
      }

      const result: Result<ModelCallResult> = {
        success: true,
        // Use the validated choice object
        value: {
          content: choice.message?.content || '',
          messages: [...messages], // Return original messages with timestamps
          fullResponse: chatCompletion // Return the full original response
        }
      };

      // Add verbose logging of the successful result
      log.verbose('generateCompletion success result', JSON.stringify(result));

      return result;
    } catch (error) {
      // --- Log the raw error object caught ---
      log.error('[ModelHandler.generateCompletion] Caught error during OpenAI API call', { rawError: error });

      // --- Enhanced Error Logging ---
      log.error('--- Error during openai.chat.completions.create ---');
      if (error instanceof Error) {
        log.error(`Error Name: ${error.name}`);
        log.error(`Error Message: ${error.message}`);
        log.error(`Error Stack: ${error.stack}`);
      } else {
        log.error('Caught non-Error object:', error); // Log the raw object if it's not an Error instance
      }
      if (error instanceof OpenAI.APIError) {
        log.error(`API Error Status: ${error.status}`);
        log.error(`API Error Type: ${error.type}`);
        log.error(`API Error Code: ${error.code}`);
        log.error(`API Error Param: ${error.param}`);
        log.error(`API Error Headers: ${JSON.stringify(error.headers)}`);
      }
      log.error('--- End Error Details ---');
      // --- End Enhanced Error Logging ---

      // Handle API errors
      if (error instanceof OpenAI.APIError) {
        // The SDK's APIError.message is often terse (e.g. "429 Provider returned
        // error"). The real reason lives in the parsed response body
        // (error.error); extractProviderErrorDetails digs it out so the user
        // sees something actionable instead of a generic line.
        const body = (error as any).error as any; // parsed response body, if any
        const extracted = ModelHandler.extractProviderErrorDetails(body, error.message);

        // Prefer the response header retry-after; fall back to the body's
        // metadata.retry_after_seconds (already surfaced by the helper).
        const headers = (error.headers || {}) as Record<string, unknown>;
        const headerRetryAfter = headers['retry-after'] ?? headers['Retry-After'];
        const retryAfter =
          headerRetryAfter !== undefined ? String(headerRetryAfter) : extracted.retryAfter;
        const rateLimitReset =
          headers['x-ratelimit-reset'] ?? headers['x-ratelimit-reset-requests'];

        const errorResult: Result<ModelCallResult> = {
          success: false,
          error: createModelError(
            'api_error',
            extracted.message,
            modelId,
            undefined,
            {
              status: error.status,
              // Prefer the body's values; fall back to the SDK's.
              type: extracted.type ?? error.type,
              code: extracted.code ?? error.code,
              param: extracted.param ?? error.param,
              retryAfter,
              rateLimitReset: rateLimitReset !== undefined ? String(rateLimitReset) : undefined,
              // The full parsed provider body is the richest source of truth.
              providerError: extracted.providerError,
              // Include stack trace if available
              stack: error.stack
            }
          )
        };

        // Add verbose logging of the API error
        log.verbose('generateCompletion API error', JSON.stringify(errorResult));

        return errorResult;
      }

      // Handle other errors
      const errorResult: Result<ModelCallResult> = {
        success: false,
        error: createModelError(
          'unknown_error',
          error instanceof Error ? error.message : String(error),
          modelId,
          undefined,
          {
            // Include stack trace if available
            stack: error instanceof Error ? error.stack : undefined
          }
        )
      };

      // Add verbose logging of the unknown error
      log.verbose('generateCompletion unknown error', JSON.stringify(errorResult));

      return errorResult;
    }
  }

  /**
   * Process tool calls - pure function
   */
  public static async processToolCalls( // Make public static
    input: ToolCallProcessingInput
  ): Promise<Result<ToolCallProcessingResult>> {
    const { toolCalls, toolNameMap } = input;

    // Add verbose logging of the input
    log.verbose('processToolCalls input', JSON.stringify(input));

    if (!toolCalls || toolCalls.length === 0) {
      const emptyResult: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages: [],
          processedToolCalls: []
        }
      };

      // Add verbose logging of the empty result
      log.verbose('processToolCalls empty result', JSON.stringify(emptyResult));

      return emptyResult;
    }

    try {
      // Array to collect new messages with tool results (using FlujoChatMessage)
      const toolCallMessages: FlujoChatMessage[] = [];
      const processedToolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
        id: string;
        result: string;
      }> = [];

      // Process each tool call
      for (const toolCall of toolCalls) {
        const { id, function: { name, arguments: argsString } } = toolCall;

        try {
          // Parse the arguments
          const args = JSON.parse(argsString);
          log.info("trying to call tool", name)
          // Check if it's a handoff tool
          if (name.startsWith('handoff_to_') || name === 'handoff') {
            // Process handoff tool directly
            log.info(`Processing handoff tool: ${name}`);

            // Return success for handoff tools
            const result = {
              success: true,
              data: { handoff: true, args }
            };

            // Format the result
            const resultContent = JSON.stringify(result.data);

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now() // Add timestamp
            });

            // Add to processed tool calls
            processedToolCalls.push({
              name,
              args,
              id,
              result: resultContent
            });

            // Skip to the next tool call
            continue;
          }

          // Decode the model-facing name back to (server, tool). New names use the
          // mcp_<slug>_<hash> scheme (decoded via toolNameMap); legacy conversations
          // used _-_-_SERVER_-_-_TOOL (decoded by decodeToolName's fallback).
          const decoded = decodeToolName(name, toolNameMap);
          if (!decoded) {
            log.error("invalid tool format", name)
            throw new Error(`Invalid tool name format: ${name}`);
          }

          const serverName = decoded.server;
          const toolName = decoded.tool;

          // Call the tool via MCP service
          const result = await mcpService.callTool(
            serverName,
            toolName,
            args
          );

          // Format the result
          const resultContent = result.success
            ? JSON.stringify(result.data)
            : `Error: ${result.error}`;

            // Add tool result message with timestamp and ID
            toolCallMessages.push({
              id: uuidv4(), // Generate unique ID
              role: "tool",
              tool_call_id: id,
              content: resultContent,
              timestamp: Date.now() // Add timestamp
            });

          // Add to processed tool calls
          processedToolCalls.push({
            name,
            args,
            id,
            result: resultContent
          });
        } catch (error) {
          const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
          // Add error message for this specific tool call with timestamp and ID
          toolCallMessages.push({
            id: uuidv4(), // Generate unique ID
            role: "tool",
            tool_call_id: id,
            content: errorMessage,
            timestamp: Date.now() // Add timestamp
          });

          // Add to processed tool calls with error
          processedToolCalls.push({
            name,
            args: {},
            id,
            result: errorMessage
          });
        }
      }

      const result: Result<ToolCallProcessingResult> = {
        success: true,
        value: {
          toolCallMessages,
          processedToolCalls
        }
      };

      // Add verbose logging of the successful result
      log.verbose('processToolCalls success result', JSON.stringify(result));

      return result;
    } catch (error) {
      const errorResult: Result<ToolCallProcessingResult> = {
        success: false,
        error: createToolError(
          'tool_processing_failed',
          error instanceof Error ? error.message : String(error),
          'unknown'
        )
      };

      // Add verbose logging of the error result
      log.verbose('processToolCalls error result', JSON.stringify(errorResult));

      return errorResult;
    }
  }

  /**
   * Check if response has tool calls - pure function
   */
  private static hasToolCalls(response: ModelCallResult): boolean {
    return !!(
      response.fullResponse?.choices?.[0]?.message?.tool_calls &&
      response.fullResponse.choices[0].message.tool_calls.length > 0
    );
  }
}
