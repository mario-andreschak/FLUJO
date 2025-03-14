import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { processChatCompletion } from './chatCompletionService';
import { parseRequestParameters, _logRequestDetails } from './requestParser';

const log = createLogger('app/v1/chat/completions/route');

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
      // Return OpenAI-compatible rate limit error
      // https://platform.openai.com/docs/guides/error-codes/api-errors
      return NextResponse.json(
        {
          error: {
            message: 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            param: null
          }
        },
        { status: 429 }
      );
    }
    
    // Parse parameters from either query string or body
    log.debug('Parsing request parameters', { requestId });
    const data = await parseRequestParameters(request);
    
    // Create a truncated version of the data for logging
    const truncatedData = { ...data };
    if (truncatedData.messages && Array.isArray(truncatedData.messages)) {
      truncatedData.messages = truncatedData.messages.map(msg => {
        if (msg && msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
          return {
            ...msg,
            content: msg.content.substring(0, 100) + `... (${msg.content.length - 100} more characters)`
          };
        }
        return msg;
      });
    }
    
    log.info('Request parameters parsed, processing chat completion', {
      requestId,
      model: truncatedData.model,
      messageCount: truncatedData.messages?.length || 0,
      stream: truncatedData.stream,
      temperature: truncatedData.temperature,
      max_tokens: truncatedData.max_tokens
    });
    
    const response = await processChatCompletion(data);
    
    const duration = Date.now() - startTime;
    log.info('Request processed successfully', {
      requestId,
      duration: `${duration}ms`,
      status: response?.status || 'unknown'
    });
    
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error('Error handling request', {
      requestId,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      duration: `${duration}ms`
    });
    
    // Return OpenAI-compatible error format
    // https://platform.openai.com/docs/guides/error-codes/api-errors
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to process chat completion',
          type: 'internal_error',
          code: 'internal_error',
          param: null
        }
      },
      { status: 500 }
    );
  }
}

// Handle GET requests
export async function GET(request: NextRequest) {
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
export async function POST(request: NextRequest) {
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
