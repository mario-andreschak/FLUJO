import { acquireChatIngress, isChatIngressError, type ChatIngressPermit } from '@/utils/http/chatIngress';
import { checkChatRateLimit } from '@/utils/http/chatRateLimit';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { processChatCompletion } from './chatCompletionService';
import {
  InvalidPersonaChatMetadataError,
  parseRequestParameters,
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

// Handle both GET and POST requests with a common handler
async function handleRequest(request: NextRequest) {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}`;
  log.info('Handling request', {
    requestId,
    method: request.method,
  });
  
  let ingress: ChatIngressPermit | undefined;
  try {
    // Get client IP for rate limiting
    // Check rate limit
    const rate = checkChatRateLimit(request.headers.get('x-forwarded-for'));
    if (rate !== 'allowed') {
      const duration = Date.now() - startTime;
      log.warn('Rate limit exceeded, returning 429 response', {
        requestId,
        duration: `${duration}ms`
      });
      // Return OpenAI-compatible rate limit error with CORS headers
      return NextResponse.json(
        {
          error: {
            message: rate === 'capacity' ? 'Chat IP quota capacity is busy. Retry after the current minute window expires.' : 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: rate === 'capacity' ? 'chat_rate_capacity' : 'rate_limit_exceeded',
            param: null
          }
        },
        { 
          status: 429,
          headers: { ...corsHeaders, 'Retry-After': '60' }
        }
      );
    }
    
    // Parse parameters from either query string or body
    log.debug('Parsing request parameters', { requestId });
    // parseRequestParameters now returns ParsedChatCompletionRequest which includes flujo and requireApproval
    ingress = acquireChatIngress(request);
    const parsedData = await parseRequestParameters(request, ingress);
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
        if (
          existingState.personaBehaviorSlotKey
          && (personaTarget.behaviorSlotKey ?? 'primary') !== existingState.personaBehaviorSlotKey
        ) {
          return NextResponse.json({
            error: {
              message: 'This conversation is already using a different Persona role or Behavior.',
              type: 'invalid_request_error',
              code: 'persona_conversation_behavior_locked',
              param: 'metadata.behaviorSlotKey',
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

    log.info('Request parameters parsed, processing chat completion', {
      requestId,
      modelCharacters: completionData.model?.length,
      messageCount: completionData.messages?.length || 0,
      stream: completionData.stream === true,
      temperature: typeof completionData.temperature === 'number' && Number.isFinite(completionData.temperature) ? completionData.temperature : undefined,
      max_tokens: typeof completionData.max_tokens === 'number' && Number.isFinite(completionData.max_tokens) ? completionData.max_tokens : undefined,
      flujo,
      hasConversationId: Boolean(conversation_id),
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
      ingress,
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
    if (error instanceof ConversationLogReadPressureError) throw error;
    const duration = Date.now() - startTime;
    const ingressError = isChatIngressError(error);
    const unsupportedTool = error instanceof UnsupportedOpenAIToolTypeError;
    const invalidPersonaMetadata = error instanceof InvalidPersonaChatMetadataError;
    const errorCode = ingressError ? error.code : unsupportedTool ? 'unsupported_tool_type'
      : invalidPersonaMetadata ? 'invalid_persona_metadata' : 'internal_error';
    log.error('Error handling request', {
      requestId,
      // Error messages/stacks can contain arbitrary wire values (including a
      // multi-megabyte unsupported tool type). Log only the bounded category.
      code: errorCode,
      duration: `${duration}ms`
    });
    
    // Return OpenAI-compatible error format with CORS headers
    return NextResponse.json(
      {
        error: {
          message: unsupportedTool ? 'Unsupported OpenAI tool type; FLUJO supports function tools only.'
            : error instanceof Error ? error.message : 'Failed to process chat completion',
          type: ingressError ? (error.status === 429 ? 'rate_limit_error' : error.status === 503 ? 'api_error' : 'invalid_request_error') : unsupportedTool || invalidPersonaMetadata ? 'invalid_request_error' : 'internal_error',
          code: errorCode,
          param: null
        }
      },
      { 
        status: ingressError ? error.status : unsupportedTool || invalidPersonaMetadata ? 400 : 500,
        headers: { ...corsHeaders, ...(ingressError && (error.status === 429 || error.status === 503) ? { 'Retry-After': '5' } : {}) }
      }
    );
  } finally {
    ingress?.release();
  }
}

// Handle OPTIONS requests for CORS preflight
async function OPTIONS_handler(request: NextRequest) {
  const requestId = `options-${Date.now()}`;
  log.info('OPTIONS request received (CORS preflight)', {
    requestId,
    hasOrigin: request.headers.has('origin')
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
    hasContentType: request.headers.has('content-type'),
    hasContentLength: request.headers.has('content-length')
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
