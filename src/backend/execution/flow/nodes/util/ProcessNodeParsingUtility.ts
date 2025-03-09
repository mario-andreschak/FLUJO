import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { modelService } from '@/backend/services/model';

const log = createLogger('backend/flow/execution/nodes/util/ProcessNodeParsingUtility');

interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // Arguments must be a JSON string
  };
}

interface ParseResult {
  success: boolean;
  toolCalls?: ParsedToolCall[];
  error?: string;
}

/**
 * Parse tool calls from text response when a model doesn't support structured tool calls
 * This handles both JSON and XML formatted tool calls in the text
 */
export async function parseToolCalls(responseContent: string, modelId: string): Promise<ParseResult> {
  log.debug(`parseToolCalls: Parsing tool calls for modelId: ${modelId}`);

  try {
    // Get the model to retrieve the function calling schema
    const model = await modelService.getModel(modelId);
    if (!model) {
      log.warn(`parseToolCalls: Model not found: ${modelId}`);
      return { success: false, error: `Model not found: ${modelId}` };
    }

    const pattern = model.functionCallingSchema;
    if (!pattern) {
      log.warn(`parseToolCalls: No functionCallingSchema found for model: ${modelId}`);
      return { success: false, error: `No function calling schema found for model: ${modelId}` };
    }

    // Try JSON parsing first
    try {
      // Just to validate the pattern is JSON
      JSON.parse(pattern);
      
      const toolCalls: ParsedToolCall[] = [];
      
      // Extract all JSON objects from the response content
      const jsonObjects = extractJsonObjects(responseContent);
      
      if (jsonObjects.length === 0) {
        log.debug('parseToolCalls: No JSON objects found in response content');
      } else {
        log.debug(`parseToolCalls: Found ${jsonObjects.length} JSON objects in response content`);
      }

      // Process each JSON object
      for (const jsonObj of jsonObjects) {
        if (jsonObj.tool) {
          const toolName = jsonObj.tool;
          const parameters = jsonObj.parameters || {};

          toolCalls.push({
            id: `FLUJO-${uuidv4()}`,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(parameters),
            },
          });
          
          log.debug(`parseToolCalls: Parsed JSON tool call: ${toolName}`);
        }
      }
      
      if (toolCalls.length > 0) {
        log.info(`parseToolCalls: Successfully parsed ${toolCalls.length} tool calls from JSON`);
        return { success: true, toolCalls };
      } else {
        log.debug('parseToolCalls: No valid tool calls found in JSON objects');
      }

    } catch (jsonError) {
      // If JSON parsing fails, try XML parsing
      log.debug('parseToolCalls: JSON parsing failed, attempting XML parsing', jsonError);
    }

    // Try XML parsing
    const toolCalls: ParsedToolCall[] = [];
    const toolRegex = /<([a-zA-Z0-9_-]+)>\s*([\s\S]*?)\s*<\/\1>/g;
    let toolMatch;

    while ((toolMatch = toolRegex.exec(responseContent)) !== null) {
      const toolName = toolMatch[1];
      const toolContent = toolMatch[2];
      const paramRegex = /<([a-zA-Z0-9_-]+)>\s*([\s\S]*?)\s*<\/\1>/g;
      let paramMatch;
      const parameters: { [key: string]: string } = {};

      while ((paramMatch = paramRegex.exec(toolContent)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2];
        parameters[paramName] = paramValue;
      }

      toolCalls.push({
        id: `FLUJO-${uuidv4()}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(parameters),
        },
      });
      
      log.debug(`parseToolCalls: Parsed XML tool call: ${toolName}`);
    }
    
    if (toolCalls.length > 0) {
      log.info(`parseToolCalls: Successfully parsed ${toolCalls.length} tool calls from XML`);
      return { success: true, toolCalls };
    }

    log.warn('parseToolCalls: Could not parse tool calls from response content');
    return { success: false, error: 'Could not parse tool calls from response content' };

  } catch (error) {
    log.error('parseToolCalls: Error parsing tool calls:', error);
    return {
      success: false,
      error: `Error parsing tool calls: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extract all JSON objects from a string
 * This handles cases where the JSON objects are embedded in text
 */
function extractJsonObjects(text: string): any[] {
  const results: any[] = [];
  
  // Try to parse the entire text as JSON first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    } else {
      return [parsed];
    }
  } catch (e) {
    // Not a complete JSON, continue with extraction
  }
  
  // Find all potential JSON objects in the text
  const jsonRegex = /\{(?:[^{}]|(?:\{(?:[^{}]|(?:\{[^{}]*\}))*\}))*\}/g;
  const matches = text.match(jsonRegex);
  
  if (!matches) {
    return [];
  }
  
  // Try to parse each match
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match);
      results.push(parsed);
    } catch (e) {
      // Skip invalid JSON
    }
  }
  
  return results;
}
