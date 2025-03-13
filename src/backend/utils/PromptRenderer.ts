import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/utils/PromptRenderer');

export interface PromptRenderOptions {
  renderMode?: 'raw' | 'rendered'; // For tool pills: raw shows ${-_-_-server-_-_-name}, rendered shows descriptions
  includeConversationHistory?: boolean;
  excludeModelPrompt?: boolean; // Override node's excludeModelPrompt setting
  excludeStartNodePrompt?: boolean; // Override node's excludeStartNodePrompt setting
}

export class PromptRenderer {
  /**
   * Main method to render a complete prompt
   * 
   * @param flowId - The ID of the flow
   * @param nodeId - The ID of the node
   * @param options - Rendering options
   * @returns The rendered prompt
   */
  async renderPrompt(flowId: string, nodeId: string, options?: PromptRenderOptions): Promise<string> {
    const renderMode = options?.renderMode || 'rendered';
    const includeConversationHistory = options?.includeConversationHistory || false;

    log.info(`Rendering prompt for node ${nodeId} in flow ${flowId}`, { renderMode, includeConversationHistory });

    // Get the node prompt and exclusion settings
    const {
      prompt: nodePrompt,
      excludeModelPrompt: nodeExcludeModelPrompt,
      excludeStartNodePrompt: nodeExcludeStartNodePrompt
    } = await this.findNodePrompt(nodeId, flowId);

    // Use options to override node settings if provided
    const excludeModelPrompt = options?.excludeModelPrompt !== undefined
      ? options?.excludeModelPrompt
      : nodeExcludeModelPrompt;

    const excludeStartNodePrompt = options?.excludeStartNodePrompt !== undefined
      ? options?.excludeStartNodePrompt
      : nodeExcludeStartNodePrompt;

    log.debug('Exclusion settings', {
      excludeModelPrompt,
      excludeStartNodePrompt,
      fromOptions: {
        excludeModelPrompt: options?.excludeModelPrompt !== undefined,
        excludeStartNodePrompt: options?.excludeStartNodePrompt !== undefined
      }
    });

    // Build the complete prompt
    let completePrompt = '';

    // 1. Start Node Prompt (if not excluded)
    if (!excludeStartNodePrompt) {
      const startNodePrompt = await this.findStartNodePrompt(flowId);
      if (startNodePrompt) {
        log.debug('Adding start node prompt', { length: startNodePrompt.length });
        completePrompt += startNodePrompt + '\n\n';
      }
    }

    // 2. Model Prompt (if not excluded)
    if (!excludeModelPrompt) {
      const { prompt: modelPrompt, modelId, reasoningSchema, functionCallingSchema } = await this.findModelPrompt(nodeId, flowId);
      if (modelPrompt) {
        log.debug('Adding model prompt', { modelId, length: modelPrompt.length });
        completePrompt += modelPrompt + '\n\n';
      }

      // Add reasoning schema if available
      if (reasoningSchema) {
        completePrompt += `Please use the following pattern to mark your reasoning: ${reasoningSchema}\n\n`;
      }

      // Add function calling schema if available
      if (functionCallingSchema) {
        completePrompt += `Please use the following pattern to use a tool: ${functionCallingSchema}\n\n`;
      }
    }

    // 3. Node Prompt
    if (nodePrompt) {
      log.debug('Adding node prompt', { length: nodePrompt.length });
      completePrompt += nodePrompt;
    }

    // 4. Resolve tool pills
    completePrompt = await this.resolveToolPills(completePrompt, renderMode);

    // 5. Add placeholder for conversation history if requested
    if (includeConversationHistory) {
      log.debug('Adding conversation history placeholder');
      completePrompt += '\n\n[Conversation History will be included here]';
    }

    log.info('Prompt rendering completed', {
      totalLength: completePrompt.length,
      hasStartNodePrompt: !excludeStartNodePrompt,
      hasModelPrompt: !excludeModelPrompt,
      hasNodePrompt: !!nodePrompt,
      includesConversationHistory: includeConversationHistory
    });

    return completePrompt;
  }

  /**
   * Find the start node of a flow and return its prompt template
   * 
   * @param flowId - The ID of the flow
   * @returns The prompt template of the start node
   */
  private async findStartNodePrompt(flowId: string): Promise<string> {
    log.debug(`Finding start node prompt for flow ${flowId}`);

    // Get the flow
    const flow = await flowService.getFlow(flowId);
    if (!flow) {
      log.warn(`Flow not found: ${flowId}`);
      return '';
    }

    // Find the start node
    const startNode = flow.nodes.find(node => node.type === 'start');
    if (!startNode) {
      log.warn(`Start node not found in flow: ${flowId}`);
      return '';
    }

    // Return the prompt template
    const promptTemplate = startNode.data.properties?.promptTemplate || '';
    log.debug(`Found start node prompt`, {
      nodeId: startNode.id,
      length: promptTemplate.length
    });

    return promptTemplate;
  }

  /**
   * Find the model assigned to a node and return its prompt template
   * 
   * @param nodeId - The ID of the node
   * @param flowId - The ID of the flow
   * @returns The prompt template of the model, the model ID, and the reasoning and function calling schemas
   */
  private async findModelPrompt(nodeId: string, flowId: string): Promise<{
    prompt: string;
    modelId: string | null;
    reasoningSchema: string | null;
    functionCallingSchema: string | null;
  }> {
    log.debug(`Finding model prompt for node ${nodeId} in flow ${flowId}`);

    // Get the flow
    const flow = await flowService.getFlow(flowId);
    if (!flow) {
      log.warn(`Flow not found: ${flowId}`);
      return { prompt: '', modelId: null, reasoningSchema: null, functionCallingSchema: null };
    }

    // Find the node
    const node = flow.nodes.find(n => n.id === nodeId);
    if (!node) {
      log.warn(`Node not found: ${nodeId} in flow: ${flowId}`);
      return { prompt: '', modelId: null, reasoningSchema: null, functionCallingSchema: null };
    }

    // Check if the node has a bound model
    const modelId = node.data.properties?.boundModel;
    if (!modelId) {
      log.debug(`No model bound to node ${nodeId}`);
      return { prompt: '', modelId: null, reasoningSchema: null, functionCallingSchema: null };
    }

    // Get the model
    const model = await modelService.getModel(modelId);
    if (!model) {
      log.warn(`Model not found: ${modelId}`);
      return { prompt: '', modelId: null, reasoningSchema: null, functionCallingSchema: null };
    }

    // Return the model's prompt template, reasoning schema, and function calling schema
    const promptTemplate = model.promptTemplate || '';
    const reasoningSchema = model.reasoningSchema || null;
    const functionCallingSchema = model.functionCallingSchema || null;

    log.debug(`Found model prompt`, {
      modelId,
      modelName: model.name,
      length: promptTemplate.length,
    });

    return {
      prompt: promptTemplate,
      modelId,
      reasoningSchema,
      functionCallingSchema
    };
  }

  /**
   * Find a node's prompt template and exclusion settings
   * 
   * @param nodeId - The ID of the node
   * @param flowId - The ID of the flow
   * @returns The node's prompt template and exclusion settings
   */
  private async findNodePrompt(nodeId: string, flowId: string): Promise<{
    prompt: string;
    excludeModelPrompt: boolean;
    excludeStartNodePrompt: boolean;
  }> {
    log.debug(`Finding node prompt for node ${nodeId} in flow ${flowId}`);

    // Get the flow
    const flow = await flowService.getFlow(flowId);
    if (!flow) {
      log.warn(`Flow not found: ${flowId}`);
      return { prompt: '', excludeModelPrompt: false, excludeStartNodePrompt: false };
    }

    // Find the node
    const node = flow.nodes.find(n => n.id === nodeId);
    if (!node) {
      log.warn(`Node not found: ${nodeId} in flow: ${flowId}`);
      return { prompt: '', excludeModelPrompt: false, excludeStartNodePrompt: false };
    }

    // Return the node's prompt template and exclusion settings
    const promptTemplate = node.data.properties?.promptTemplate || '';
    const excludeModelPrompt = node.data.properties?.excludeModelPrompt || false;
    const excludeStartNodePrompt = node.data.properties?.excludeStartNodePrompt || false;

    log.debug(`Found node prompt and settings`, {
      length: promptTemplate.length,
      excludeModelPrompt,
      excludeStartNodePrompt
    });

    return {
      prompt: promptTemplate,
      excludeModelPrompt,
      excludeStartNodePrompt
    };
  }

  /**
     * Resolve tool pills in a prompt, replacing them with detailed tool information.
     * Retries up to 3 times on failure.
     * 
     * @param prompt - The prompt containing tool pills
     * @param renderMode - Whether to render tool pills as raw or with descriptions
     * @returns The prompt with resolved tool pills
     */
  private async resolveToolPills(prompt: string, renderMode: 'raw' | 'rendered'): Promise<string> {
    log.debug(`Resolving tool pills in prompt`, { renderMode, promptLength: prompt.length });

    if (renderMode === 'raw') {
      log.debug('Using raw mode, not resolving tool pills');
      return prompt; // Return the raw prompt with tool pills
    }

    // Regular expression to find tool pills: ${-_-_-serverName-_-_-toolName}
    const toolPillRegex = /\${-_-_-([\w-^}]+)-_-_-([\w-^}]+)}/g;

    // Replace each tool pill with its description
    let resolvedPrompt = prompt;
    let match;

    // Create a copy of the prompt to work with
    const promptCopy = prompt.slice();

    // Find all matches first
    const matches: Array<{
      fullMatch: string;
      serverName: string;
      toolName: string;
      index: number;
    }> = [];

    while ((match = toolPillRegex.exec(promptCopy)) !== null) {
      matches.push({
        fullMatch: match[0],
        serverName: match[1],
        toolName: match[2],
        index: match.index
      });
    }

    log.debug(`Found ${matches.length} tool pills to resolve`);

    // Process each match with retries
    for (const { fullMatch, serverName, toolName } of matches) {
      let resolved = false;
      let retryCount = 0;
      let description = '';

      while (!resolved && retryCount < 3) {
        try {
          // Get the server status
          let serverStatus = await mcpService.getServerStatus(serverName);
          log.debug(`Server in status ${serverStatus}`);

          if (serverStatus.status !== 'connected') {
            log.debug(`force connect ${serverName}`);            
            await mcpService.connectServer(serverName);
            serverStatus = await mcpService.getServerStatus(serverName);
            log.debug(`Server in status ${serverStatus.status} after force connecting`);
            log.debug(`Server in status ${serverStatus.message?.toString()} after force connecting`);
          }
          
          if (serverStatus.status === 'connected') {
            // Get the tools for this server
            const toolsResult = await mcpService.listServerTools(serverName);
            log.debug(`toolResult.status is ${toolsResult.error?.toString()}`)
            if (toolsResult.tools && toolsResult.tools.length > 0) {
            log.debug(`listed ${toolsResult.tools.length} tools from ${serverName} for tool render`);
              // Find the specific tool
              const tool = toolsResult.tools.find(t => t.name === toolName);

              if (tool) {
                // Format parameters if available
                const paramsText = this.formatToolParameters(tool);

                // Create enhanced description
                description = `[The user is referencing a tool \`${serverName}:${toolName}\` (${tool.description || 'No description'})${paramsText}]`;

                // Replace the tool pill
                resolvedPrompt = resolvedPrompt.replace(fullMatch, description);
                resolved = true;
              } else {
                log.warn(`Tool not found: ${toolName} in server ${serverName}`);
                retryCount++;
                await this.delay(Math.pow(2, retryCount) * 100);
              }
            } else {
              log.warn(`No tools available for server ${serverName}`);
              retryCount++;
              await this.delay(Math.pow(2, retryCount) * 100);
            }
          } else {
            log.warn(`Server not connected: ${serverName}, status: ${serverStatus.status}`);
            retryCount++;
            await this.delay(Math.pow(2, retryCount) * 100);
          }
        } catch (error) {
          // Error occurred, retry
          retryCount++;
          log.warn(`Error resolving tool pill (attempt ${retryCount}): ${fullMatch}`, error);
          await this.delay(Math.pow(2, retryCount) * 100); // Exponential backoff
        }
      }
      if (!resolved) {
        log.error(`Failed to resolve tool pill after multiple retries: ${fullMatch}`);
      }
    }

    log.debug(`Resolved tool pills`);
    return resolvedPrompt;
  }

  // Helper method to format tool parameters
  private formatToolParameters(tool: any): string {
    if (!tool.inputSchema || !tool.inputSchema.properties) {
      return '';
    }

    const params: string[] = [];
    for (const key in tool.inputSchema.properties) {
      const prop = tool.inputSchema.properties[key];
      const description = prop.description ? `(${prop.description})` : '';
      params.push(`\`${key}\` ${description}`);
    }

    return params.length > 0 ? ` with parameters ${params.join(', ')}` : '';
  }

  // Helper method for delay between retries
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export a singleton instance
export const promptRenderer = new PromptRenderer();
