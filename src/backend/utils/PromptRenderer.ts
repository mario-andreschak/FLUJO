import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';
import { findBindings } from '@/utils/shared';

const log = createLogger('backend/utils/PromptRenderer');

export interface PromptRenderOptions {
  renderMode?: 'raw' | 'rendered'; // For tool pills: raw shows ${_-_-_server_-_-_name}, rendered shows descriptions
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
    let functionCallingSchema: string | null = null;

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
      const modelPromptResult = await this.findModelPrompt(nodeId, flowId);
      if (modelPromptResult.prompt) {
        log.debug('Adding model prompt', { modelId: modelPromptResult.modelId, length: modelPromptResult.prompt.length });
        completePrompt += modelPromptResult.prompt + '\n\n';
      }

      // Store function calling schema for later use
      functionCallingSchema = modelPromptResult.functionCallingSchema;

      // Add reasoning schema if available
      if (modelPromptResult.reasoningSchema) {
        completePrompt += `Please use the following pattern to mark your reasoning: ${modelPromptResult.reasoningSchema}\n\n`;
      }

      // Add function calling schema if available
      if (functionCallingSchema) {
        completePrompt += `Please use the following pattern to use a tool: ${functionCallingSchema}\n\n`;
      }

      completePrompt += `# GENERAL INFORMATION:\n`
      completePrompt += `You are operating in a workflow with other agents, each with it's own responsibilities.\n`
      completePrompt += `You will receive a message from the user which may contain tasks that are outside of your scope.\n`
      completePrompt += `Focus on the part of the user-message that can be accomplished using the tools provided to you.\n\n`
      completePrompt += `You may do multiple tool calls.\n\n`
      completePrompt += `After you completed the user's request to the best of your ability, you can use the 'handoff_to_xxxx' tool.\n\n`
      completePrompt += `The processing may be handed back to you as part of a loop. In this case repeat processing your instructions as if you were executing them for the first time. \n\n`

    }

    // 3. Node Prompt
    if (nodePrompt) {
      completePrompt += `# YOUR OPERATIONAL INSTRUCTION:\n`
      log.debug('Adding node prompt', { length: nodePrompt.length });
      completePrompt += nodePrompt + `\n`;
    }

    // 4. Resolve binding pills: tool pills per renderMode, resource pills always inlined
    completePrompt = await this.resolveBindings(completePrompt, renderMode, functionCallingSchema);

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
   * Resolve binding pills (`${tool:...}` / `${resource:...}`, plus legacy `${_-_-_..}`).
   *
   * Tool pills follow renderMode (raw = left as the readable pill for the model to
   * reference; rendered = expanded into a tool description). Resource pills are ALWAYS
   * resolved to their contents regardless of renderMode — a literal `${resource:...}` in
   * the prompt would be meaningless to the model; the whole point of binding a resource is
   * to inline its data at run time.
   *
   * Walks matches by index against the original string so duplicate pills resolve
   * independently (no fragile first-occurrence `.replace`).
   */
  private async resolveBindings(
    prompt: string,
    renderMode: 'raw' | 'rendered',
    functionCallingSchema?: string | null
  ): Promise<string> {
    renderMode = 'raw'; // for now, keep tool pills raw (resources still always resolve)

    const matches = findBindings(prompt);
    if (matches.length === 0) {
      return prompt;
    }
    log.debug(`Resolving ${matches.length} binding pills`, { renderMode });

    const formatType = this.resolveFormatType(functionCallingSchema);

    let result = '';
    let cursor = 0;
    for (const m of matches) {
      result += prompt.slice(cursor, m.index);
      cursor = m.index + m.fullMatch.length;

      if (m.kind === 'resource') {
        result += await this.renderResourceBinding(m.server, m.name);
      } else if (renderMode === 'raw') {
        // Leave the readable tool pill in place for the model to reference.
        result += m.fullMatch;
      } else {
        result += await this.renderToolBinding(m.server, m.name, formatType, m.fullMatch);
      }
    }
    result += prompt.slice(cursor);

    log.debug('Resolved binding pills');
    return result;
  }

  /** Pick the tool-description format from the model's function-calling schema. */
  private resolveFormatType(functionCallingSchema?: string | null): 'json' | 'xml' | 'text' {
    if (!functionCallingSchema) return 'text';
    if (functionCallingSchema.includes('"tool"') && functionCallingSchema.includes('"parameters"')) {
      return 'json';
    }
    if (functionCallingSchema.includes('<') && functionCallingSchema.includes('</')) {
      return 'xml';
    }
    return 'text';
  }

  /** Ensure a server is connected, force-connecting once if needed. */
  private async ensureConnected(serverName: string): Promise<boolean> {
    let status = await mcpService.getServerStatus(serverName);
    if (status.status !== 'connected') {
      log.debug(`force connect ${serverName}`);
      await mcpService.connectServer(serverName);
      status = await mcpService.getServerStatus(serverName);
    }
    return status.status === 'connected';
  }

  /** Expand a tool pill into a description (rendered mode), retrying a few times. */
  private async renderToolBinding(
    serverName: string,
    toolName: string,
    formatType: 'json' | 'xml' | 'text',
    fullMatch: string
  ): Promise<string> {
    for (let retryCount = 0; retryCount < 3; retryCount++) {
      try {
        if (await this.ensureConnected(serverName)) {
          const toolsResult = await mcpService.listServerTools(serverName);
          const tool = toolsResult.tools?.find(t => t.name === toolName);
          if (tool) {
            switch (formatType) {
              case 'json':
                return this.formatToolDescriptionJSON(serverName, toolName, tool);
              case 'xml':
                return this.formatToolDescriptionXML(serverName, toolName, tool);
              default: {
                const paramsText = this.formatToolParameters(tool);
                return `[The user is referencing a tool \`tool:${serverName}__${toolName}\` (${tool.description || 'No description'})${paramsText}]`;
              }
            }
          }
          log.warn(`Tool not found: ${toolName} in server ${serverName}`);
        } else {
          log.warn(`Server not connected: ${serverName}`);
        }
      } catch (error) {
        log.warn(`Error resolving tool pill (attempt ${retryCount + 1}): ${fullMatch}`, error);
      }
      await this.delay(Math.pow(2, retryCount + 1) * 100);
    }
    log.error(`Failed to resolve tool pill after multiple retries: ${fullMatch}`);
    return fullMatch; // leave the pill rather than dropping the reference
  }

  /**
   * Resolve a resource pill into its contents, inlined as a clearly-delimited block.
   * On failure, emits a visible note rather than leaving the meaningless raw pill.
   */
  private async renderResourceBinding(serverName: string, uri: string): Promise<string> {
    for (let retryCount = 0; retryCount < 3; retryCount++) {
      try {
        if (await this.ensureConnected(serverName)) {
          const result = await mcpService.readResource(serverName, uri);
          if (result.success && result.data) {
            const text = this.formatResourceContents(result.data);
            return `\n[Resource ${uri} (from ${serverName})]:\n${text}\n`;
          }
          log.warn(`Failed to read resource ${uri} from ${serverName}: ${result.error}`);
          // A genuine read error (bad uri, etc.) won't fix itself on retry — stop early.
          return `[Resource ${uri} from ${serverName} could not be read: ${result.error || 'unknown error'}]`;
        }
        log.warn(`Server not connected for resource read: ${serverName}`);
      } catch (error) {
        log.warn(`Error resolving resource pill (attempt ${retryCount + 1}): ${uri}`, error);
      }
      await this.delay(Math.pow(2, retryCount + 1) * 100);
    }
    return `[Resource ${uri} from ${serverName} is currently unavailable]`;
  }

  /** Flatten an MCP ReadResourceResult into plain text for prompt inlining. */
  private formatResourceContents(data: any): string {
    const contents = data?.contents;
    if (!Array.isArray(contents) || contents.length === 0) return '(empty resource)';
    return contents
      .map((c: any) => {
        if (typeof c.text === 'string') return c.text;
        if (typeof c.blob === 'string') return `[binary ${c.mimeType || 'data'} omitted]`;
        return JSON.stringify(c);
      })
      .join('\n\n');
  }

  /**
   * Format tool description in JSON format
   */
  private formatToolDescriptionJSON(serverName: string, toolName: string, tool: any): string {
    // Generate JSON format description with proper TypeScript typing
    const toolObj: {
      tool: string;
      parameters: { [key: string]: string };
    } = {
      tool: `${toolName}`,  // Just the tool name, not the fully qualified name
      parameters: {}
    };
    
    // Add parameters if available
    if (tool.inputSchema?.properties) {
      for (const key in tool.inputSchema.properties) {
        const prop = tool.inputSchema.properties[key];
        // Use the property description as an example value
        toolObj.parameters[key] = prop.description || key;
      }
    }
    
    // Return stringified JSON with explanation
    return `[Tool: \`tool:${serverName}__${toolName}\` (${tool.description || 'No description'})
Example usage:
${JSON.stringify(toolObj, null, 2)}]`;
  }

  /**
   * Format tool description in XML format
   */
  private formatToolDescriptionXML(serverName: string, toolName: string, tool: any): string {
    // Generate XML format description
    let xmlExample = `<${toolName}>\n`;
    
    // Add parameters if available
    if (tool.inputSchema?.properties) {
      for (const key in tool.inputSchema.properties) {
        const prop = tool.inputSchema.properties[key];
        // Use the property description as example value
        xmlExample += `  <${key}>${prop.description || key}</${key}>\n`;
      }
    }
    
    xmlExample += `</${toolName}>`;
    
    // Return XML with explanation
    return `[Tool: \`tool:${serverName}__${toolName}\` (${tool.description || 'No description'})
Example usage:
${xmlExample}]`;
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
