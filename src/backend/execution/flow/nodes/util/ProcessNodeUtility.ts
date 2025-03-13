import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { modelService } from '@/backend/services/model';
import { CompletionResponse } from '@/shared/types/model/response';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/util/ProcessNodeUtility');

export class ProcessNodeUtility {
  /**
   * Parse tool descriptions based on function calling schema
   * Used to format tool descriptions for models that don't support tools natively
   */
  private static parseToolDescriptions(functionCallingSchema: string | undefined, tools: any[]): string {
    if (!tools || tools.length === 0) {
      return '';
    }
    
    log.debug('parseToolDescriptions: Generating tool descriptions based on schema');
    let toolDescriptions = '';
    
    if (functionCallingSchema && typeof functionCallingSchema === 'string') {
      log.debug('parseToolDescriptions: Using functionCallingSchema to format tool descriptions');
      
      // Try to parse as JSON first
      let isJson = false;
      try {
        JSON.parse(functionCallingSchema);
        isJson = true;
      } catch (e) {
        isJson = false;
      }
      
      if (isJson) {
        // It's a JSON schema
        toolDescriptions = '\n\nYou have access to the following tools. Use them when appropriate:\n\n';
        
        // Generate example for each tool
        tools.forEach(tool => {
          toolDescriptions += `{\n  "tool": "${tool.function.name}",\n  "parameters": {\n`;
          
          // Add parameters
          if (tool.function.parameters && tool.function.parameters.properties) {
            const properties = tool.function.parameters.properties;
            const propertyNames = Object.keys(properties);
            
            propertyNames.forEach((paramName, index) => {
              const param = properties[paramName];
              toolDescriptions += `    "${paramName}": "${param.description || paramName}"`;
              if (index < propertyNames.length - 1) {
                toolDescriptions += ',\n';
              } else {
                toolDescriptions += '\n';
              }
            });
          }
          
          toolDescriptions += '  }\n}\n\n';
        });
      } else {
        // Check if it's XML
        // Using a pattern that works without the 's' flag (which requires ES2018+)
        const xmlPattern = /<\s*([a-zA-Z][a-zA-Z0-9]*)\s*>[\s\S]*?<\s*\/\s*\1\s*>/;
        const isXml = xmlPattern.test(functionCallingSchema);
        
        if (isXml) {
          // It's an XML schema
          toolDescriptions = '\n\nYou have access to the following tools. Use them when appropriate:\n\n';
          
          // Generate example for each tool
          tools.forEach(tool => {
            toolDescriptions += `<${tool.function.name}>\n`;
            
            // Add parameters
            if (tool.function.parameters && tool.function.parameters.properties) {
              const properties = tool.function.parameters.properties;
              const propertyNames = Object.keys(properties);
              
              propertyNames.forEach(paramName => {
                const param = properties[paramName];
                toolDescriptions += `<${paramName}>${param.description || paramName}</${paramName}>\n`;
              });
            }
            
            toolDescriptions += `</${tool.function.name}>\n\n`;
          });
        } else {
          // Neither JSON nor XML, use a default format
          toolDescriptions = '\n\nYou have access to the following tools. The format for using tools is unknown for this model, but try to use them if appropriate:\n\n';
          
          // List tools and their parameters
          tools.forEach(tool => {
            toolDescriptions += `Tool: ${tool.function.name}\n`;
            
            // Add parameters
            if (tool.function.parameters && tool.function.parameters.properties) {
              toolDescriptions += 'Parameters:\n';
              
              const properties = tool.function.parameters.properties;
              const propertyNames = Object.keys(properties);
              
              propertyNames.forEach(paramName => {
                const param = properties[paramName];
                toolDescriptions += `- ${paramName}: ${param.description || paramName}\n`;
              });
            }
            
            toolDescriptions += '\n';
          });
        }
      }
    } else {
      // No schema available, use a default format
      toolDescriptions = '\n\nYou have access to the following tools. The format for using tools is unknown for this model, but try to use them if appropriate:\n\n';
      
      // List tools and their parameters
      tools.forEach(tool => {
        toolDescriptions += `Tool: ${tool.function.name}\n`;
        
        // Add parameters
        if (tool.function.parameters && tool.function.parameters.properties) {
          toolDescriptions += 'Parameters:\n';
          
          const properties = tool.function.parameters.properties;
          const propertyNames = Object.keys(properties);
          
          propertyNames.forEach(paramName => {
            const param = properties[paramName];
            toolDescriptions += `- ${paramName}: ${param.description || paramName}\n`;
          });
        }
        
        toolDescriptions += '\n';
      });
    }
    
    return toolDescriptions;
  }

  /**
   * Generate a completion using the specified model
   */
  static async generateCompletion(
    modelId: string,
    prompt: string,
    messages: any[] = [],
    tools?: any[],
    mcpContext?: any
  ): Promise<CompletionResponse> {
    log.debug(`generateCompletion: Generating completion with model: ${modelId}`);
    
    // Add verbose logging of the input parameters
    log.verbose('generateCompletion input', JSON.stringify({
      modelId,
      prompt,
      messages,
      tools,
      mcpContext
    }));
    try {
      // Get the model
      const model = await modelService.getModel(modelId);
      if (!model) {
        const errorResult = { success: false, error: `Model not found: ${modelId}` };
        
        // Add verbose logging of the error result
        log.verbose('generateCompletion model not found error', JSON.stringify(errorResult));
        
        return errorResult;
      }

      // Extract model settings
      const temperature = model.temperature ? parseFloat(model.temperature) : 0.0;

      // Resolve and decrypt the API key
      const decryptedApiKey = await modelService.resolveAndDecryptApiKey(model.encryptedApiKey);
      if (!decryptedApiKey) {
        const errorResult = { success: false, error: 'Failed to resolve or decrypt API key' };
        
        // Add verbose logging of the error result
        log.verbose('generateCompletion API key error', JSON.stringify(errorResult));
        
        return errorResult;
      } else {
        log.debug('API key successfully resolved and decrypted');
        log.debug('Request configuration', {
          model: model.name,
          temperature,
          messagesCount: messages.length + 1 // +1 for system prompt
        });
        
        if (tools && tools.length > 0) {
          log.debug('Tools configuration', { toolsCount: tools.length });
        }
      }

      // Initialize the OpenAI client
      const openai = await ProcessNodeUtility.initializeOpenAIClient(model, decryptedApiKey);
      
      // Create the request parameters
      const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: model.name,
        messages: [
          {
            role: "system",
            content: prompt
          },
          ...messages
        ],
        temperature
      };
      
      // Add tools if available
      if (tools && tools.length > 0) {
        requestParams.tools = tools;
      }
      
      log.info('generateCompletion - Calling model API');

      log.debug('generateCompletion - Calling model API - Info', JSON.stringify(requestParams));

      // Make the API request using the OpenAI client
      const chatCompletion = await openai.chat.completions.create(requestParams);

      log.debug('generateCompletion - Result from API', chatCompletion);
      
      // Add verbose logging of the API response
      log.verbose('generateCompletion API response', JSON.stringify(chatCompletion));
      // return chatCompletion;

      // Check if the response contains an error (standardized OpenAI error format)
      if (chatCompletion && typeof chatCompletion === 'object' && 'error' in chatCompletion) {
        const errorResponse = chatCompletion as { error: { message?: string, code?: string | number | null, type?: string, param?: string } };
        log.warn('generateCompletion: API returned an error response', errorResponse.error);
        const errorResult = {
          success: false,
          error: errorResponse.error.message || 'Unknown provider error',
          errorDetails: {
            message: errorResponse.error.message || 'Unknown provider error',
            type: errorResponse.error.type || 'api_error',
            code: errorResponse.error.code !== null && errorResponse.error.code !== undefined ? String(errorResponse.error.code) : undefined,
            param: errorResponse.error.param || undefined,
            name: 'ProviderError'
          }
        };
        
        // Add verbose logging of the error result
        log.verbose('generateCompletion provider error', JSON.stringify(errorResult));
        
        return errorResult;
      }      

      // Return the successful response
      // Add additional null checks to prevent "Cannot read properties of undefined" errors
      if (!chatCompletion || !chatCompletion.choices || chatCompletion.choices.length === 0) {
        log.warn('generateCompletion: Received empty or invalid response from API');
        
        // Format error in OpenAI-compatible format
        const errorResult = {
          success: false,
          error: 'Received empty or invalid response from API',
          errorDetails: {
            message: 'API returned empty or invalid response',
            type: 'api_error',
            code: 'empty_response',
            name: 'EmptyResponseError'
          }
        };
        
        // Add verbose logging of the error result
        log.verbose('generateCompletion empty response error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      // Create a standardized response with OpenAI-compatible structure
      const successResult = {
        success: true,
        content: chatCompletion.choices[0]?.message?.content || '',
        fullResponse: chatCompletion
      };
      
      // Add verbose logging of the success result
      log.verbose('generateCompletion success result', JSON.stringify(successResult));
      
      return successResult;
    } catch (error) {
      // Handle API errors
      if (error instanceof OpenAI.APIError) {
        const errorDetails = {
          status: error.status,
          message: error.message,
          type: error.type,
          code: error.code ? String(error.code) : undefined, // Convert to string to match our type
          name: error.name,
          param: error.param
        };
        
        log.error('generateCompletion: OpenAI API error:', errorDetails);
        
        // Special handling for models that don't support tools
        if (error.status === 400 && error.message.includes("does not support tools") && tools && tools.length > 0) {
          log.warn('Model does not support tools. Retrying without tools parameter...');
        log.info('Model does not support tools. Retrying without tools parameter...');
        
        // Add verbose logging of the retry attempt
        log.verbose('generateCompletion retrying without tools', JSON.stringify({
          modelId,
          prompt,
          messagesCount: messages.length,
          toolsCount: tools?.length || 0
        }));
        
        return ProcessNodeUtility.retryWithoutTools(modelId, prompt, messages, tools);
        }
        
        // Return error in OpenAI-compatible format
        const errorResult = {
          success: false,
          error: `Model API error: ${error.message}`,
          errorDetails: {
            message: error.message,
            type: error.type || 'api_error',
            code: error.code !== null && error.code !== undefined ? String(error.code) : undefined,
            param: error.param || undefined,
            status: error.status,
            name: error.name
          }
        };
        
        // Add verbose logging of the API error result
        log.verbose('generateCompletion API error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      // Handle other errors
      const errorDetails = error instanceof Error
        ? {
            message: error.message,
            name: error.name,
            stack: error.stack
          }
        : { message: 'Unknown error' };
      
      log.error('generateCompletion: Error generating completion:', errorDetails);
      
      const errorResult = {
        success: false,
        error: `Failed to generate completion: ${errorDetails.message}`,
        errorDetails: errorDetails
      };
      
      // Add verbose logging of the general error result
      log.verbose('generateCompletion general error', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }

  /**
   * Initialize OpenAI client with the appropriate settings
   */
  private static async initializeOpenAIClient(model: any, apiKey: string): Promise<OpenAI> {
    log.debug('initializeOpenAIClient: Initializing OpenAI client');
    
    // Determine the API endpoint
    let baseURL = model.baseUrl || '';
    if (baseURL.endsWith('/chat/completions')) {
      // Remove the /chat/completions part as the client will add it
      baseURL = baseURL.replace('/chat/completions', '');
      log.debug('Removed /chat/completions suffix from baseURL');
    }
    
    log.debug('Creating OpenAI client', { baseURL });
    
    // Create and return the OpenAI client
    return new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL
    });
  }

  /**
   * Retry the completion request without tools parameter
   * Used when a model doesn't support tools but tools were provided
   */
  private static async retryWithoutTools(
    modelId: string,
    prompt: string,
    messages: any[] = [],
    tools?: any[]
  ): Promise<CompletionResponse> {
    log.info('retryWithoutTools: Retrying completion without tools parameter');
    
    // Add verbose logging of the input parameters
    log.verbose('retryWithoutTools input', JSON.stringify({
      modelId,
      prompt,
      messages,
      tools
    }));
    try {
      // Get the model
      const model = await modelService.getModel(modelId);
      if (!model) {
        const errorResult = { success: false, error: `Model not found: ${modelId}` };
        
        // Add verbose logging of the error result
        log.verbose('retryWithoutTools model not found error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      // Resolve and decrypt the API key
      const decryptedApiKey = await modelService.resolveAndDecryptApiKey(model.encryptedApiKey);
      if (!decryptedApiKey) {
        const errorResult = { success: false, error: 'Failed to resolve or decrypt API key' };
        
        // Add verbose logging of the error result
        log.verbose('retryWithoutTools API key error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      // Initialize the OpenAI client
      const openai = await ProcessNodeUtility.initializeOpenAIClient(model, decryptedApiKey);
      
      // Create a modified system prompt that includes tool descriptions
      let modifiedPrompt = prompt;
      
      // If tools are provided, add their descriptions to the system prompt
      if (tools && tools.length > 0) {
        log.debug('retryWithoutTools: Adding tool descriptions to system prompt');
        
        // Get the function calling schema from the model
        const functionCallingSchema = model.functionCallingSchema;
        
        if (functionCallingSchema && typeof functionCallingSchema === 'string') {
          modifiedPrompt = modifiedPrompt.replace(functionCallingSchema, '');
        }
        
        // Generate tool descriptions using the shared method
        const toolDescriptions = ProcessNodeUtility.parseToolDescriptions(
          functionCallingSchema, 
          tools
        );
        
        // Add the tool descriptions to the prompt
        modifiedPrompt = prompt + toolDescriptions;
        log.debug('retryWithoutTools: Added tool descriptions to system prompt');
        log.debug('retryWithoutTools: ', toolDescriptions);
      }
      
      // Create the request parameters without tools
      const retryRequestParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: model.name,
        messages: [
          {
            role: "system",
            content: modifiedPrompt
          },
          ...messages
        ],
        temperature: model.temperature ? parseFloat(model.temperature) : 0.0
      };
      
      // Note: We're intentionally not adding tools here, even if they were provided
      // The system prompt already contains instructions on how to use tools
      
      log.info('retryWithoutTools: Calling model API without tools parameter');
      log.debug('retryRequestParams:', retryRequestParams);
      
      // Make the API request using the OpenAI client
      const chatCompletion = await openai.chat.completions.create(retryRequestParams);
      
      log.debug('retryWithoutTools: Result from API', chatCompletion);
      
      // Add verbose logging of the API response
      log.verbose('retryWithoutTools API response', JSON.stringify(chatCompletion));
      
      // Check if the response contains an error (standardized OpenAI error format)
      if (chatCompletion && typeof chatCompletion === 'object' && 'error' in chatCompletion) {
        const errorResponse = chatCompletion as { error: { message?: string, code?: string | number, type?: string, param?: string } };
        log.warn('retryWithoutTools: API returned an error response', errorResponse.error);
        const errorResult = {
          success: false,
          error: errorResponse.error.message || 'Unknown provider error',
          errorDetails: {
            message: errorResponse.error.message || 'Unknown provider error',
            type: errorResponse.error.type || 'api_error',
            code: errorResponse.error.code ? String(errorResponse.error.code) : undefined,
            param: errorResponse.error.param,
            name: 'ProviderError'
          }
        };
        
        // Add verbose logging of the error result
        log.verbose('retryWithoutTools provider error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      // Return the successful response from retry
      if (!chatCompletion || !chatCompletion.choices || chatCompletion.choices.length === 0) {
        log.warn('retryWithoutTools: Received empty or invalid response from API');
        const errorResult = {
          success: false,
          error: 'Received empty or invalid response from API retry',
          errorDetails: {
            message: 'API returned empty or invalid response on retry',
            name: 'EmptyResponseError'
          }
        };
        
        // Add verbose logging of the error result
        log.verbose('retryWithoutTools empty response error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      const successResult = {
        success: true,
        content: chatCompletion.choices[0]?.message?.content || '',
        fullResponse: chatCompletion
      };
      
      // Add verbose logging of the success result
      log.verbose('retryWithoutTools success result', JSON.stringify(successResult));
      
      return successResult;
      
    } catch (error) {
      log.error('retryWithoutTools: Error during retry without tools:', error);
      
      // Format error details
      const errorDetails = error instanceof Error
        ? {
            message: error.message,
            name: error.name,
            stack: error.stack
          }
        : { message: 'Unknown error' };
      
      const errorResult = {
        success: false,
        error: `Failed to generate completion without tools: ${errorDetails.message}`,
        errorDetails: errorDetails
      };
      
      // Add verbose logging of the error result
      log.verbose('retryWithoutTools general error', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }

  /**
   * Process tool calls from the model response
   * @param response The completion response containing tool calls
   * @returns An array of new messages with tool results
   */
  static async processToolCalls(
    response: CompletionResponse
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const toolCalls = response.fullResponse?.choices?.[0]?.message?.tool_calls;
    
    // Add verbose logging of the input
    log.verbose('processToolCalls input', JSON.stringify({
      response: {
        success: response.success,
        content: response.content,
        toolCalls: toolCalls
      }
    }));
    
    if (!toolCalls || toolCalls.length === 0) {
      log.info('No tool calls to process');
      
      // Add verbose logging of the empty result
      log.verbose('processToolCalls empty result', JSON.stringify([]));
      
      return [];
    }
    
    log.info(`processToolCalls: Processing ${toolCalls.length} tool calls`);
    log.debug('Tool calls details', {
      toolCalls: toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        argsString: tc.function?.arguments
      }))
    });
    
    // Array to collect new messages with tool results
    const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    
    // Process each tool call
    for (const toolCall of toolCalls) {
      const { id, function: { name, arguments: argsString } } = toolCall;
      
      try {
        // Parse the arguments
        const args = JSON.parse(argsString);
        
        // Extract server and tool names from the formatted name
        // Format is "-_-_-serverName-_-_-toolName"
        const parts = name.split('-_-_-');
        if (parts.length !== 3) {
          throw new Error(`Invalid tool name format: ${name}`);
        }
        
        const serverName = parts[1];
        const toolName = parts[2];
        
        log.debug(`Preparing to call tool: ${toolName} from server ${serverName}`, { toolCallId: id });
        
        // Import the MCP service dynamically to avoid circular dependencies
        const { mcpService } = await import('@/backend/services/mcp');
        
        // Call the tool via MCP service
        log.info(`Calling tool: ${toolName} with args:`, args);
        const result = await mcpService.callTool(
          serverName,
          toolName,
          args
        );
        
        // Format the result
        const resultContent = result.success
          ? JSON.stringify(result.data)
          : `Error: ${result.error}`;
        
        log.debug(`Tool call result for ${name}`, {
          success: result.success,
          resultLength: resultContent.length
        });
        
        // Add tool result message
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: resultContent
        });
      } catch (error) {
        log.error(`Error processing tool call ${name}:`, error);
        
        // Add error message
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }
    
    log.info(`processToolCalls: Completed processing ${toolCalls.length} tool calls, returning ${newMessages.length} messages`);
    
    // Add verbose logging of the result
    log.verbose('processToolCalls result', JSON.stringify(newMessages));
    
    return newMessages;
  }
}
