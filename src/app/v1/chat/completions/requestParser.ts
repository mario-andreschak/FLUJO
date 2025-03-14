import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';

const log = createLogger('app/v1/chat/completions/requestParser');

// Types for better TypeScript support using OpenAI SDK types directly
export interface ChatCompletionRequest {
  model: string;
  messages: Array<OpenAI.ChatCompletionMessageParam>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
}

// Parse request parameters from either query string or body
export async function parseRequestParameters(request: NextRequest): Promise<ChatCompletionRequest> {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}`;
  log.debug('Parsing request parameters', { requestId, method: request.method, url: request.url });
  
  if (request.method === 'GET') {
    // Extract parameters from query string
    const url = new URL(request.url);
    log.debug('Parsing GET request query parameters', {
      requestId,
      searchParams: Object.fromEntries(url.searchParams)
    });
    
    const model = url.searchParams.get('model') || '';
    const messageContent = url.searchParams.get('message') || '';
    const stream = url.searchParams.get('stream') === 'true';
    const temperature = parseFloat(url.searchParams.get('temperature') || '0');
    const max_tokens = parseInt(url.searchParams.get('max_tokens') || '0', 10);
    
    log.debug('Extracted parameters from query string', {
      requestId,
      model,
      messageContentLength: messageContent.length,
      messageContentPreview: messageContent.length > 50 ?
        `${messageContent.substring(0, 50)}...` : messageContent,
      stream,
      temperature: isNaN(temperature) ? undefined : temperature,
      max_tokens: isNaN(max_tokens) ? undefined : max_tokens
    });
    
    const result = {
      model,
      messages: [
        {
          role: 'user',
          content: messageContent
        } as OpenAI.ChatCompletionMessageParam
      ],
      stream,
      temperature: isNaN(temperature) ? undefined : temperature,
      max_tokens: isNaN(max_tokens) ? undefined : max_tokens
    };
    
    const duration = Date.now() - startTime;
    log.info('GET request parameters parsed successfully', {
      requestId,
      duration: `${duration}ms`,
      model,
      stream
    });
    
    return result;
  } else {
    // Parse the request body for POST
    log.debug('Parsing request body for POST', { requestId });
    try {
      const contentType = request.headers.get('content-type') || '';
      log.debug('Request content type', { requestId, contentType });
      
      const data = await request.json();
      
      const duration = Date.now() - startTime;
      log.info('POST request body parsed successfully', {
        requestId,
        duration: `${duration}ms`,
        model: data.model,
        hasMessages: !!data.messages,
        messageCount: data.messages?.length || 0,
        stream: !!data.stream,
        temperature: data.temperature
      });
      
      return data;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Error parsing request body', {
        requestId,
        error,
        duration: `${duration}ms`,
        headers: Object.fromEntries(request.headers)
      });
      throw error;
    }
  }
}

// Helper function to log detailed request information
// Currently disabled but kept for future use
export async function _logRequestDetails(request: NextRequest) {
  return; // for now return early
  log.debug('Request details', { 
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers)
  });
  
  if (request.nextUrl.search) {
    log.debug('Query parameters', { params: Object.fromEntries(request.nextUrl.searchParams) });
  }
  
  try {
    // Clone the request to avoid consuming the body
    const clonedRequest = request.clone();
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        const body = await clonedRequest.json();
        // Truncate messages content if present
        if (body && body.messages && Array.isArray(body.messages)) {
          const truncatedBody = { ...body };
          // Use OpenAI type instead of custom interface
          type Message = OpenAI.ChatCompletionMessageParam;
          
          truncatedBody.messages = body.messages.map((msg: Message) => {
            if (msg && msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
              return {
                ...msg,
                content: msg.content.substring(0, 100) + `... (${msg.content.length - 100} more characters)`
              };
            }
            return msg;
          });
          log.debug('Request body (JSON, truncated)', truncatedBody);
        } else {
          log.debug('Request body (JSON)', body);
        }
      } catch (error) {
        log.debug('Failed to parse JSON body', error);
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const formData = await clonedRequest.formData();
        log.debug('Request body (Form)', Object.fromEntries(formData));
      } catch (error) {
        log.debug('Failed to parse form data', error);
      }
    } else {
      try {
        const text = await clonedRequest.text();
        const truncatedText = text.length > 100 ? 
          text.substring(0, 100) + `... (${text.length - 100} more characters)` : text;
        log.debug('Request body (Text, truncated)', { text: truncatedText });
      } catch (error) {
        log.debug('Failed to read request text', error);
      }
    }
  } catch (error) {
    log.debug('Failed to process request body', error);
  }
}
