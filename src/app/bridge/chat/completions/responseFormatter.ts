import { createLogger } from '@/utils/logger';
import { ChatCompletionRequest } from './requestParser';
import { FlowExecutionResponse } from '@/shared/types/flow/response';

const log = createLogger('app/bridge/chat/completions/responseFormatter');

/**
 * Checks if a string is valid JSON and extracts the message property if it exists
 */
function extractMessageFromJson(content: string): string | null {
  log.debug('Checking if content is JSON with message property', { contentLength: content.length });
  try {
    // Try to parse the content as JSON
    const parsed = JSON.parse(content);
    
    // Check if the parsed object has a message property
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
      log.debug('Found message property in JSON', { messageLength: parsed.message.length });
      return parsed.message;
    }
    
    log.debug('Content is valid JSON but has no message property');
    return null;
  } catch (e) {
    // Not valid JSON
    log.debug('Content is not valid JSON', content);
    return null;
  }
}

/**
 * Formats the response content based on specific requirements
 */
export function formatResponseContent(request: ChatCompletionRequest, result: FlowExecutionResponse): string {
  log.info('Formatting response content', { 
    messageCount: result.messages?.length || 0
  });

  // Check if debug mode is enabled
  const messagesJson = JSON.stringify(result.messages || []);
  const isDebugMode = messagesJson.toUpperCase().includes('FLUJODEBUG=1');
  if (isDebugMode) {
    log.debug('Debug mode enabled');
  }
  
  // Get the initial user message
  const initialUserMessage = request.messages.find(m => m.role === 'user')?.content || '';
  const hasAttemptCompletion = typeof initialUserMessage === 'string' && initialUserMessage.includes('attempt_completion');
  const hasFinalResponse = typeof initialUserMessage === 'string' && initialUserMessage.includes('final_response');
  
  if (hasAttemptCompletion) {
    log.debug('Detected attempt_completion in user message');
  }
  if (hasFinalResponse) {
    log.debug('Detected final_response in user message');
  }
  
  // Determine the requested format
  const formatType = 
    initialUserMessage.includes('~FLUJO=JSON') ? 'json' :
    initialUserMessage.includes('~FLUJO=HTML') ? 'html' :
    initialUserMessage.includes('~FLUJO=TEXT') ? 'text' : 
    initialUserMessage.includes('~FLUJO=MARKDOWN') ? 'markdown' : 'markdown'; // Default to text
  
  // Check if expanded view is requested (show all messages)
  const isExpandedView = typeof initialUserMessage === 'string' && initialUserMessage.includes('~FLUJOEXPAND=1');
  if (isExpandedView) {
    log.debug('Expanded view enabled - showing all messages');
  }
  
  log.info(`Using format type: ${formatType}`);
  
  let formattedContent = '';
  
  // 2.1 & 2.2: Include execution tracking and all messages if in debug mode
  if (isDebugMode) {
    // Add execution tracking
    if (result.nodeExecutionTracker && result.nodeExecutionTracker.length > 0) {
      formattedContent += '## Flow Execution Tracking\n\n';
      
      result.nodeExecutionTracker.forEach((node) => {
        formattedContent += `### Node: ${node.nodeName || 'Unknown'} (Type: ${node.nodeType})\n`;
        
        if (node.nodeType === 'ProcessNode') {
          formattedContent += `- Model: ${node.modelDisplayName}\n`;
          formattedContent += `- Technical Name: ${node.modelTechnicalName}\n`;
          formattedContent += `- Allowed Tools: ${node.allowedTools}\n`;
        }
        
        if (node.nodeType === 'ModelError') {
          formattedContent += `- Error: ${node.error}\n`;
          if (node.errorDetails) {
            if (node.errorDetails.name) formattedContent += `- Error Type: ${node.errorDetails.name}\n`;
            if (node.errorDetails.message) formattedContent += `- Message: ${node.errorDetails.message}\n`;
            if (node.errorDetails.stack && typeof node.errorDetails.stack === 'string') {
              formattedContent += `- Stack: ${node.errorDetails.stack.split('\n')[0]}\n`;
            }
          }
        }
        
        formattedContent += `- Timestamp: ${node.timestamp}\n\n`;
      });
      
      formattedContent += '---\n\n';
    }
    
    // Add all messages except initial user message
    const allMessages = Array.isArray(result.messages) ? result.messages.filter((_, index) => index > 0) : [];
    formattedContent += JSON.stringify(allMessages, null, 2) + '\n\n';
  }
  
  // 2.3 & 2.4: Format based on initial user message content
  if (hasAttemptCompletion || hasFinalResponse) {
    // Add all messages except first and last as JSON
    const intermediateMessages = Array.isArray(result.messages) && result.messages.length > 2 ? 
      result.messages.slice(1, -1) : [];
    if (intermediateMessages.length > 0) {
      formattedContent += JSON.stringify(intermediateMessages, null, 2) + '\n\n';
    }
    
    // Get the last message
    const lastMessage = Array.isArray(result.messages) && result.messages.length > 0 ? 
      result.messages[result.messages.length - 1] : null;
    let lastMessageContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
    
    // Check if the last message content is JSON with a message property
    const extractedMessage = extractMessageFromJson(lastMessageContent);
    if (extractedMessage !== null) {
      log.info('Extracted message from JSON in last message for attempt_completion/final_response', { 
        originalLength: lastMessageContent.length,
        extractedLength: extractedMessage.length
      });
      lastMessageContent = extractedMessage;
    }
    
    // Wrap in appropriate XML tag
    let tagName = hasAttemptCompletion ? 'attempt_completion' : '';
    tagName = hasFinalResponse ? 'final_response' : '';
    
    formattedContent += `<${tagName}>\n${lastMessageContent}\n</${tagName}>`;
  } else {
    // Format based on the requested format type
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    let lastMessageContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
    
    // Check if the last message content is JSON with a message property
    const extractedMessage = extractMessageFromJson(lastMessageContent);
    if (extractedMessage !== null) {
      log.info('Extracted message from JSON in last message', { 
        originalLength: lastMessageContent.length,
        extractedLength: extractedMessage.length
      });
      lastMessageContent = extractedMessage;
    }
    
    // // Add intermediate messages as JSON if they exist
    // const intermediateMessages = messages.length > 2 ? messages.slice(1, -1) : [];
    // if (intermediateMessages.length > 0) {
    //   formattedContent += JSON.stringify(intermediateMessages, null, 2) + '\n\n';
    // }
    
    // Format the last message based on the requested format
    if (formatType === 'json') {
      // JSON format - keep as is
      formattedContent += lastMessageContent;
    } else if (formatType === 'html') {
      // HTML format - create a beautiful HTML conversation
      if (isExpandedView) {
        // Show all messages if expanded view is requested
        formattedContent += formatAsHtml(messages);
      } else {
        // Show only the last message
        // Create a modified message with the extracted content
        const modifiedLastMessage = lastMessage ? {
          ...lastMessage,
          content: lastMessageContent
        } : null;
        formattedContent += formatAsHtml(modifiedLastMessage ? [modifiedLastMessage] : []);
      }
    } else if (formatType === 'markdown') {
      // MARKDOWN format - format as markdown conversation
      if (isExpandedView) {
        // Show all messages if expanded view is requested
        formattedContent += formatAsMarkdown(messages);
      } else {
        // Show only the last message
        // Create a modified message with the extracted content
        const modifiedLastMessage = lastMessage ? {
          ...lastMessage,
          content: lastMessageContent
        } : null;
        formattedContent += formatAsMarkdown(modifiedLastMessage ? [modifiedLastMessage] : []);
      }
    } else {
      // TEXT format (default) - format as plain text conversation
      if (isExpandedView) {
        // Show all messages if expanded view is requested
        formattedContent += formatAsText(messages);
      } else {
        // Show only the last message
        // Create a modified message with the extracted content
        const modifiedLastMessage = lastMessage ? {
          ...lastMessage,
          content: lastMessageContent
        } : null;
        formattedContent += formatAsText(modifiedLastMessage ? [modifiedLastMessage] : []);
      }
    }
  }
  
  log.info('Response formatting completed', { contentLength: formattedContent.length });
  return formattedContent;
}

/**
 * Formats messages as HTML
 */
function formatAsHtml(messages: Array<{role: string; content: string | null}>): string {
  log.debug('Formatting messages as HTML', { messageCount: messages.length });
  
  // If we only have one message (last message only mode), don't include role headers
  const isLastMessageOnly = messages.length === 1;
  
  // Create HTML structure
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FLUJO Conversation</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f9f9f9;
    }
    .conversation {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .message {
      padding: 15px;
      border-radius: 10px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    .user-message {
      background-color: #e1f5fe;
      border-left: 5px solid #03a9f4;
      align-self: flex-start;
    }
    .assistant-message {
      background-color: #f0f4c3;
      border-left: 5px solid #cddc39;
      align-self: flex-start;
    }
    .system-message {
      background-color: #e8eaf6;
      border-left: 5px solid #3f51b5;
      font-style: italic;
    }
    .message-header {
      font-weight: bold;
      margin-bottom: 10px;
      color: #555;
    }
    .code-block {
      background-color: #272822;
      color: #f8f8f2;
      padding: 10px;
      border-radius: 5px;
      font-family: 'Courier New', Courier, monospace;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    p {
      margin: 0 0 10px 0;
    }
  </style>
</head>
<body>
  <div class="conversation">`;

  // Add each message
  messages.forEach(message => {
    const role = message.role.toLowerCase();
    let content = message.content || '';
    
    // Check if the content is JSON with a message property
    const extractedMessage = extractMessageFromJson(content);
    if (extractedMessage !== null) {
      log.debug('Extracted message from JSON in HTML formatting', { 
        originalLength: content.length,
        extractedLength: extractedMessage.length
      });
      content = extractedMessage;
    }
    
    // Determine message class based on role
    const messageClass = role === 'user' ? 'user-message' : 
                         role === 'assistant' ? 'assistant-message' : 'system-message';
    
    // Start message div
    html += `\n    <div class="message ${messageClass}">`;
    
    // Only include role header if we're showing multiple messages
    if (!isLastMessageOnly) {
      html += `\n      <div class="message-header">${role.charAt(0).toUpperCase() + role.slice(1)}</div>`;
    }
    
    html += `\n      <div class="message-content">`;
    
    // Process content - handle code blocks and line breaks
    let processedContent = content;
    
    // Replace code blocks
    processedContent = processedContent.replace(/```([\s\S]*?)```/g, (match, codeContent) => {
      return `<div class="code-block">${escapeHtml(codeContent)}</div>`;
    });
    
    // Replace inline code
    processedContent = processedContent.replace(/`([^`]+)`/g, (match, code) => {
      return `<code>${escapeHtml(code)}</code>`;
    });
    
    // Handle paragraphs and line breaks
    const paragraphs = processedContent.split('\n\n');
    const formattedParagraphs = paragraphs.map(para => {
      // Skip if this is already a code block (wrapped in div)
      if (para.startsWith('<div class="code-block">')) {
        return para;
      }
      // Handle line breaks within paragraphs
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    });
    
    html += `\n        ${formattedParagraphs.join('\n        ')}`;
    html += `\n      </div>`;
    html += `\n    </div>`;
  });
  
  // Close HTML structure
  html += `\n  </div>\n</body>\n</html>`;
  
  log.debug('HTML formatting complete', { htmlLength: html.length });
  return html;
}

/**
 * Resolves JSON content in a string
 * This function attempts to parse any JSON-like structures in the content
 * and convert them to a readable markdown format
 */
function resolveJsonContent(content: string, formatType: string = 'markdown'): string {
  log.debug('Resolving JSON content', { contentLength: content.length, formatType });
  let processedContent = content;
  
  try {
    // Look for JSON objects in the content
    const jsonRegex = /(\{[\s\S]*?\}|\[[\s\S]*?\])/g;
    let jsonMatchCount = 0;
    processedContent = processedContent.replace(jsonRegex, (match) => {
      try {
        // Try to parse the JSON
        const parsed = JSON.parse(match);
        jsonMatchCount++;
        log.debug('Successfully parsed JSON object', { matchIndex: jsonMatchCount });
        
        // If we're in markdown mode, convert JSON to markdown
        if (formatType === 'markdown') {
          return jsonToMarkdown(parsed);
        } else {
          // Otherwise just format the JSON
          return JSON.stringify(parsed, null, 2);
        }
      } catch (e) {
        // If parsing fails, return the original match
        log.debug('Failed to parse potential JSON match', { matchLength: match.length });
        return match;
      }
    });
    
    // Look for tool requests/responses in specific formats
    // Example: <tool_name>...</tool_name>
    const toolRegex = /<([a-zA-Z_]+)>([\s\S]*?)<\/\1>/g;
    let toolMatchCount = 0;
    processedContent = processedContent.replace(toolRegex, (match, toolName, content) => {
      toolMatchCount++;
      log.debug('Found tool pattern', { toolName, matchIndex: toolMatchCount });
      
      if (formatType === 'markdown') {
        return `### Tool: ${toolName}\n\n${content.trim()}`;
      } else {
        return `Tool: ${toolName}\n${content.trim()}`;
      }
    });
    
    // Handle system messages that might be in JSON format
    if (processedContent.includes('"role":"system"') || processedContent.includes('"role": "system"')) {
      log.debug('Detected potential system message in JSON format');
      try {
        const systemMsgObj = JSON.parse(processedContent);
        if (systemMsgObj.role === 'system' && systemMsgObj.content) {
          log.debug('Successfully extracted system message content');
          return systemMsgObj.content;
        }
      } catch (e) {
        log.debug('Failed to parse as system message JSON');
        // Not a valid JSON system message, continue with other processing
      }
    }
  } catch (e) {
    // If any error occurs during processing, return the original content
    log.error('Error resolving JSON content:', e);
    return content;
  }
  
  return processedContent;
}

/**
 * Converts a JSON object to markdown format
 */
function jsonToMarkdown(json: any, level: number = 0): string {
  if (json === null) return '`null`';
  if (json === undefined) return '`undefined`';
  
  // Handle primitive types
  if (typeof json !== 'object') {
    if (typeof json === 'string') return `"${json}"`;
    return `\`${json}\``;
  }
  
  // Handle arrays
  if (Array.isArray(json)) {
    if (json.length === 0) return '`[]`';
    
    let result = '';
    json.forEach((item, index) => {
      const indent = '  '.repeat(level);
      result += `\n${indent}- ${jsonToMarkdown(item, level + 1)}`;
    });
    return result;
  }
  
  // Handle objects
  const keys = Object.keys(json);
  if (keys.length === 0) return '`{}`';
  
  let result = '';
  keys.forEach(key => {
    const indent = '  '.repeat(level);
    const value = json[key];
    
    // For nested objects or arrays, create a section
    if (typeof value === 'object' && value !== null && (Object.keys(value).length > 0 || Array.isArray(value) && value.length > 0)) {
      result += `\n${indent}**${key}**:${jsonToMarkdown(value, level + 1)}`;
    } else {
      result += `\n${indent}**${key}**: ${jsonToMarkdown(value, level + 1)}`;
    }
  });
  
  return result;
}

/**
 * Formats messages as markdown
 */
function formatAsMarkdown(messages: Array<{role: string; content: string | null}>): string {
  log.debug('Formatting messages as markdown', { messageCount: messages.length });
  let markdown = '';
  
  // If we only have one message (last message only mode), don't include role headers
  const isLastMessageOnly = messages.length === 1;
  
  messages.forEach((message, index) => {
    const role = message.role.toUpperCase();
    let content = message.content || '';
    
    // Check if the content is JSON with a message property
    const extractedMessage = extractMessageFromJson(content);
    if (extractedMessage !== null) {
      log.debug('Extracted message from JSON in markdown formatting', { 
        originalLength: content.length,
        extractedLength: extractedMessage.length
      });
      content = extractedMessage;
    }
    
    // Add separator between messages (only for multiple messages)
    if (index > 0) {
      markdown += '\n\n---\n\n';
    }
    
    // Add role header as markdown heading (only for multiple messages)
    if (!isLastMessageOnly) {
      markdown += `## ${role}\n\n`;
    }
    
    // Process content to resolve any JSON and convert to markdown
    const processedContent = resolveJsonContent(content, 'markdown');
    
    // Add the processed content
    markdown += processedContent;
  });
  
  log.debug('Markdown formatting complete', { markdownLength: markdown.length });
  return markdown;
}

/**
 * Formats messages as plain text
 */
function formatAsText(messages: Array<{role: string; content: string | null}>): string {
  log.debug('Formatting messages as plain text', { messageCount: messages.length });
  let text = '';
  
  // If we only have one message (last message only mode), don't include role headers
  const isLastMessageOnly = messages.length === 1;
  
  messages.forEach((message, index) => {
    const role = message.role.toUpperCase();
    let content = message.content || '';
    
    // Check if the content is JSON with a message property
    const extractedMessage = extractMessageFromJson(content);
    if (extractedMessage !== null) {
      log.debug('Extracted message from JSON in text formatting', { 
        originalLength: content.length,
        extractedLength: extractedMessage.length
      });
      content = extractedMessage;
    }
    
    // Add separator between messages (only for multiple messages)
    if (index > 0) {
      text += '\n\n' + '-'.repeat(50) + '\n\n';
    }
    
    // Add role header (only for multiple messages)
    if (!isLastMessageOnly) {
      text += `${role}:\n\n`;
    }
    
    // Process content to resolve any JSON
    const processedContent = resolveJsonContent(content, 'text');
    
    // Add content with proper indentation for code blocks
    const lines = processedContent.split('\n');
    let inCodeBlock = false;
    
    lines.forEach(line => {
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        text += line + '\n';
      } else if (inCodeBlock) {
        // Indent code blocks for better readability
        text += '    ' + line + '\n';
      } else {
        text += line + '\n';
      }
    });
  });
  
  log.debug('Text formatting complete', { textLength: text.length });
  return text;
}

/**
 * Helper function to escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
