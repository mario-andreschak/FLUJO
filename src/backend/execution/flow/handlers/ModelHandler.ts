import { createLogger } from '@/utils/logger';
import { 
  ModelCallInput,
  ModelCallResult,
  ToolCallProcessingInput,
  ToolCallProcessingResult
} from '../types/modelHandler';
import { ToolCallInfo } from '../types'; // Import ToolCallInfo from the main types file
import { Result, ExecutionError } from '../errors';
import { createModelError, createToolError } from '../errorFactory';
import OpenAI from 'openai';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('backend/flow/execution/handlers/ModelHandler');

export class ModelHandler {
  /**
   * Call model with tool support - performs a SINGLE API call.
   * Does NOT handle tool execution loops internally.
   */
  static async callModel(input: ModelCallInput): Promise<Result<ModelCallResult>> {
    // Remove iteration parameters as they are no longer handled here
    const { modelId, prompt, messages, tools, nodeName } = input;

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
      nodeName
    });
    
    // Add verbose logging of the entire input
    log.verbose('callModel input', JSON.stringify(input));

    // Call generateCompletion ONCE
    const response = await this.generateCompletion(modelId, prompt, messages, tools);
    
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
    const finalMessages = [...messages]; // Start with input messages

    // Format content with prefix (as before)
    const prefixedContent = modelDisplayName
      ? `## ${nodeDisplayName} - ${modelDisplayName} (${modelTechnicalName}) says:\n\n${content}`
      : content;

    // Create the assistant message
    const assistantMessage: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: prefixedContent,
      // IMPORTANT: Include tool_calls if they exist in the raw response
      tool_calls: modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls
    };
    finalMessages.push(assistantMessage);

    // Map tool calls for the result structure (if they exist)
    // This provides structured info about requested calls, but doesn't execute them
    const toolCalls = modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls?.map(tc => {
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
        messages: finalMessages, // Include the new assistant message
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
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[]
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
      // Initialize the OpenAI client
      const openai = new OpenAI({
        apiKey: decryptedApiKey,
        baseURL: model.baseUrl
      });
      
      // Create the request parameters
      const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: model.name,
        messages: messages,
        temperature
      };
      
      // Add tools if available
      if (tools && tools.length > 0) {
        requestParams.tools = tools;
      } 
      

      log.verbose(`calling chatcompletion now with MODEL ${ JSON.stringify(requestParams.model)}`)
      log.verbose(`calling chatcompletion now with TEMP ${ JSON.stringify(requestParams.temperature)}`)
      log.verbose(`calling chatcompletion now with MESSAGES ${ JSON.stringify(requestParams.messages)}`)
      log.verbose(`calling chatcompletion now with TOOLS ${ JSON.stringify(requestParams.tools)}`)
      // Make the API request using the OpenAI client
      const chatCompletion = await openai.chat.completions.create(requestParams);
      log.verbose(`chatcompletion returned`)
      log.verbose(`chatcompletion returned ${ JSON.stringify(chatCompletion)}`)

      // Create a standardized response with OpenAI-compatible structure
      const result: Result<ModelCallResult> = {
        success: true,
        value: {
          content: chatCompletion.choices[0]?.message?.content || '',
          messages: [...messages],
          fullResponse: chatCompletion
        }
      };
      
      // Add verbose logging of the successful result
      log.verbose('generateCompletion success result', JSON.stringify(result));
      
      return result;
    } catch (error) {
      log.debug(`chatcompletion raised exception ${JSON.stringify(error)}`)
      // Handle API errors
      if (error instanceof OpenAI.APIError) {
        const errorResult: Result<ModelCallResult> = {
          success: false,
          error: createModelError(
            'api_error',
            error.message,
            modelId,
            undefined,
            {
              status: error.status,
              type: error.type,
              code: error.code,
              param: error.param
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
          modelId
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
    const { toolCalls } = input;
    
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
      // Array to collect new messages with tool results
      const toolCallMessages: OpenAI.ChatCompletionMessageParam[] = [];
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
            
            // Add tool result message
            toolCallMessages.push({
              role: "tool",
              tool_call_id: id,
              content: resultContent
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
          
          // For MCP tools: Format is "_-_-_serverName_-_-_toolName"
          const parts = name.split('_-_-_');
          if (parts.length !== 3) {
            log.error("invalid tool format", name)
            throw new Error(`Invalid tool name format: ${name}`);
          }
          
          const serverName = parts[1];
          const toolName = parts[2];
          
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
          
          // Add tool result message
          toolCallMessages.push({
            role: "tool",
            tool_call_id: id,
            content: resultContent
          });
          
          // Add to processed tool calls
          processedToolCalls.push({
            name,
            args,
            id,
            result: resultContent
          });
        } catch (error) {
          // Add error message for this specific tool call
          toolCallMessages.push({
            role: "tool",
            tool_call_id: id,
            content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
          });
          
          // Add to processed tool calls with error
          processedToolCalls.push({
            name,
            args: {},
            id,
            result: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
