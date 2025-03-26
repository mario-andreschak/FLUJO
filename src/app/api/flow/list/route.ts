import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import * as flowAdapter from '../flow-adapter';

// Create a logger instance for this file
const log = createLogger('app/api/flow/list/route');

/**
 * Handle GET requests to /api/flow/list
 * This endpoint returns a list of all available flows
 */
export async function GET() {
  log.debug('GET: Listing all flows');
  
  try {
    // Use the flow adapter directly instead of making another HTTP request
    const result = await flowAdapter.loadFlows();
    
    if (!result.success) {
      log.error('GET: Error loading flows:', result.error);
      return NextResponse.json({ 
        error: result.error 
      }, { status: 500 });
    }
    
    // Transform the response format to match the Swagger documentation
    return NextResponse.json({
      flows: result.flows || []
    });
  } catch (error) {
    log.error('GET: Error listing flows:', error);
    return NextResponse.json({ 
      error: `Error listing flows: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
} 