import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { processChatCompletion } from './chatCompletionService';
import {
  InvalidPersonaChatMetadataError,
  parseRequestParameters,
  _logRequestDetails,
  ChatCompletionRequest,
} from './requestParser'; // Import ChatCompletionRequest
import { UnsupportedOpenAIToolTypeError } from '@/shared/types/openai';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';

const log = createLogger('app/v1/chat/completions/route');

// CORS headers for all responses - Allow all headers and methods for local development
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*'
};

// Rate limiting - simple implementation
const RATE_LIMIT = 6000; // requests per minute
const requestCounts = new Map<string, { count: number, resetTime: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const resetTime = Math.floor(now / 60000) * 60000 + 60000; // Next minute boundary
  
  log.debug('Checking rate limit', { ip, now, resetTime, currentLimit: RATE_LIMIT });
  
  if (!requestCounts.has(ip) || requestCounts.get(ip)!.resetTime < now) {
    const isReset = requestCounts.has(ip);
    log.info(isReset ? 'Rate limit window reset' : 'First request from IP', {
      ip,
      isReset,
      previousCount: isReset ? requestCounts.get(ip)!.count : 0
    });
    requestCounts.set(ip, { count: 1, resetTime });
    return true;
  }
  
  const record = requestCounts.get(ip)!;
  const remainingRequests = RATE_LIMIT - record.count;
  
  if (record.count >= RATE_LIMIT) {
    const timeToReset = Math.ceil((resetTime - now) / 1000);
    log.warn('Rate limit exceeded', {
      ip,
      count: record.count,
      limit: RATE_LIMIT,
      timeToResetSec: timeToReset
    });
    return false;
  }
  
  record.count++;
  log.debug('Request count incremented', {
    ip,
    count: record.count,
    remainingRequests: remainingRequests - 1,
    utilizationPercentage: Math.round((record.count / RATE_LIMIT) * 100)
  });
  return true;
}

// Handle both GET and POST requests with a common handler
async function handleRequest(request: NextRequest) {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}`;
  log.info('Handling request', {
    requestId,
    method: request.method,
    url: request.url,
    userAgent: request.headers.get('user-agent') || 'unknown'
  });
  
  try {
    // Get client IP for rate limiting
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    const referer = request.headers.get('referer') || 'unknown';
    log.debug('Request details', {
      requestId,
      ip,
      referer,
      contentType: request.headers.get('content-type') || 'unknown'
    });
    
    // Check rate limit
    if (!checkRateLimit(ip)) {
      const duration = Date.now() - startTime;
      log.warn('Rate limit exceeded, returning 429 response', {
        requestId,
        ip,
        duration: `${duration}ms`
      });
      // Return OpenAI-compatible rate limit error with CORS headers
      return NextResponse.json(
        {
          error: {
            message: 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            param: null
          }
        },
        { 
          status: 429,
          headers: corsHeaders
        }
      );
    }
    
    // Parse parameters from either query string or body
    log.debug('Parsing request parameters', { requestId });
    // parseRequestParameters now returns ParsedChatCompletionRequest which includes flujo and requireApproval
    const parsedData = await parseRequestParameters(request);
    // Destructure all flags, including flujodebug
    const {
      flujo,
      conversation_id,
      requireApproval,
      flujodebug,
      personaTarget,
      ...completionData
    } = parsedData;

    // Persona ids select a durable living actor. They follow the same selected
    // exposure policy as the rest of FLUJO's UI/control surface.
    if (personaTarget) {
      const notLocal = assertLocalRequest(request);
      if (notLocal) return notLocal;
    }
    if (conversation_id) {
      const existingState = await loadConversationState(conversation_id);
      if (isPersonaOwnedConversationState(existingState)) {
        const notLocal = assertLocalRequest(request);
        if (notLocal) return notLocal;
      }
      if (existingState?.personaArchived) {
        return NextResponse.json({
          error: {
            message: 'An anonymized Persona archive is read-only and cannot be resumed or retargeted.',
            type: 'invalid_request_error',
            code: 'persona_conversation_archived',
            param: 'metadata.conversationId',
          },
        }, { status: 409, headers: corsHeaders });
      }
      if (existingState?.personaAttribution || existingState?.personaTargetId) {
        const requiredPersonaId = existingState.personaAttribution?.personaId
          ?? existingState.personaTargetId;
        if (
          !personaTarget
          || personaTarget.personaId !== requiredPersonaId
        ) {
          return NextResponse.json({
            error: {
              message: 'Persona-owned conversations require matching Persona routing metadata.',
              type: 'invalid_request_error',
              code: 'persona_conversation_requires_target',
              param: 'metadata.personaId',
            },
          }, { status: 409, headers: corsHeaders });
        }
      } else if (isPersonaOwnedConversationState(existingState)) {
        return NextResponse.json({
          error: {
            message: 'Persona conversation ownership metadata is incomplete and cannot be resumed.',
            type: 'invalid_request_error',
            code: 'persona_conversation_attribution_incomplete',
            param: 'metadata.conversationId',
          },
        }, { status: 409, headers: corsHeaders });
      } else if (existingState && personaTarget) {
        return NextResponse.json({
          error: {
            message: 'An existing Flow conversation cannot be converted to a Persona conversation.',
            type: 'invalid_request_error',
            code: 'persona_conversation_target_locked',
            param: 'metadata.personaId',
          },
        }, { status: 409, headers: corsHeaders });
      }
    }

    // Truncated payload dump for VERBOSE only. Built lazily (thunk): the map
    // walks every message (and multipart image parts), which is O(history) per
    // request — previously this ran unconditionally even at LOG_LEVEL=ERROR.
    // Truncation keeps long content and pasted-screenshot data URLs out of logs.
    log.verbose('Chat completion request payload (truncated)', () => ({
      ...completionData,
      messages: Array.isArray(completionData.messages)
        ? completionData.messages.map((msg): any => {
            if (msg && msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
              return {
                ...msg,
                content: msg.content.substring(0, 100) + `... (${msg.content.length - 100} more characters)`
              };
            }
            if (msg && Array.isArray(msg.content)) {
              return {
                ...msg,
                content: msg.content.map((part: any) => {
                  if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 100) {
                    return { ...part, text: part.text.substring(0, 100) + `... (${part.text.length - 100} more characters)` };
                  }
                  if (part?.type === 'image_url') {
                    const url: string = part.image_url?.url ?? '';
                    const isData = url.startsWith('data:');
                    return { ...part, image_url: { ...part.image_url, url: isData ? `[image data url, ${url.length} chars]` : url } };
                  }
                  return part;
                })
              };
            }
            return msg;
          })
        : completionData.messages,
    }));

    log.info('Request parameters parsed, processing chat completion', {
      requestId,
      model: completionData.model,
      messageCount: completionData.messages?.length || 0,
      stream: completionData.stream,
      temperature: completionData.temperature,
      max_tokens: completionData.max_tokens,
      flujo,
      conversation_id,
      requireApproval,
      flujodebug,
      personaTargeted: Boolean(personaTarget),
    });

    // Pass all flags to processChatCompletion
    const response = await processChatCompletion(
      completionData as ChatCompletionRequest, // Pass the remaining data
      flujo,
      requireApproval,
      flujodebug, // Pass the new flag
      conversation_id,
      false, // continueDebug: only the debug "Continue" control sets this
      true, // userTurn: a fresh user-initiated turn → re-sync debugMode to flujodebug
      personaTarget,
    );

    const duration = Date.now() - startTime;
    log.info('Request processed successfully', {
      requestId,
      duration: `${duration}ms`,
      status: response?.status || 'unknown'
    });
    
    // Clone the response and add CORS headers
    const responseWithCors = new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        ...corsHeaders
      }
    });
    
    return responseWithCors;
  } catch (error) {
    const duration = Date.now() - startTime;
    const unsupportedTool = error instanceof UnsupportedOpenAIToolTypeError;
    const invalidPersonaMetadata = error instanceof InvalidPersonaChatMetadataError;
    log.error('Error handling request', {
      requestId,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      duration: `${duration}ms`
    });
    
    // Return OpenAI-compatible error format with CORS headers
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to process chat completion',
          type: unsupportedTool || invalidPersonaMetadata ? 'invalid_request_error' : 'internal_error',
          code: unsupportedTool
            ? error.code
            : invalidPersonaMetadata
              ? error.code
              : 'internal_error',
          param: null
        }
      },
      { 
        status: unsupportedTool || invalidPersonaMetadata ? 400 : 500,
        headers: corsHeaders
      }
    );
  }
}

// Handle OPTIONS requests for CORS preflight
async function OPTIONS_handler(request: NextRequest) {
  const requestId = `options-${Date.now()}`;
  log.info('OPTIONS request received (CORS preflight)', {
    requestId,
    url: request.url,
    origin: request.headers.get('origin') || 'unknown'
  });
  
  // Return a 204 No Content response with CORS headers
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      'Access-Control-Max-Age': '86400' // 24 hours
    }
  });
}

// Handle GET requests
async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const requestId = `get-${Date.now()}`;
  log.info('GET request received', {
    requestId,
    url: request.url,
    userAgent: request.headers.get('user-agent') || 'unknown'
  });
  
  const startTime = Date.now();
  const response = await handleRequest(request);
  
  const duration = Date.now() - startTime;
  log.info('GET request completed', {
    requestId,
    duration: `${duration}ms`,
    status: response?.status || 'unknown'
  });
  
  return response;
}

// Handle POST requests
async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const requestId = `post-${Date.now()}`;
  log.info('POST request received', {
    requestId,
    url: request.url,
    contentType: request.headers.get('content-type') || 'unknown',
    contentLength: request.headers.get('content-length') || 'unknown'
  });
  
  const startTime = Date.now();
  const response = await handleRequest(request);
  
  const duration = Date.now() - startTime;
  log.info('POST request completed', {
    requestId,
    duration: `${duration}ms`,
    status: response?.status || 'unknown'
  });
  
  return response;
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const OPTIONS = withWorkspaceRoute(OPTIONS_handler);
