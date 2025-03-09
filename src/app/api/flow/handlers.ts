import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import * as flowAdapter from './flow-adapter';
import { Flow } from '@/shared/types/flow';

// Create a logger instance for this file
const log = createLogger('app/api/flow/handlers');

/**
 * Handle GET requests
 */
export async function GET(req: NextRequest) {
  log.debug('GET: Entering method');
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

    // Handle different actions
    if (action === 'listFlows') {
      log.debug('GET: Listing all flows');
      
      try {
        const result = await flowAdapter.loadFlows();
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        
        return NextResponse.json({
          success: true,
          flows: result.flows
        });
      } catch (error) {
        log.error('GET: Error listing flows:', error);
        return NextResponse.json({ 
          error: `Error listing flows: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Get a specific flow
    else if (action === 'getFlow') {
      const flowId = searchParams.get('id');
      
      if (!flowId) {
        return NextResponse.json({ error: 'Flow ID is required' }, { status: 400 });
      }
      
      log.debug(`GET: Getting flow with ID: ${flowId}`);
      
      try {
        const result = await flowAdapter.getFlow(flowId);
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 404 });
        }
        
        return NextResponse.json({
          success: true,
          flow: result.flow
        });
      } catch (error) {
        log.error(`GET: Error getting flow ${flowId}:`, error);
        return NextResponse.json({ 
          error: `Error getting flow: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('GET: Flow API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}

/**
 * Handle POST requests
 */
export async function POST(req: NextRequest) {
  log.debug('POST: Entering method');
  try {
    const body = await req.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

    // Handle different actions
    if (action === 'addFlow' || action === 'updateFlow') {
      const { flow } = body;
      
      if (!flow) {
        return NextResponse.json({ error: 'Flow data is required' }, { status: 400 });
      }
      
      log.debug(`POST: ${action === 'addFlow' ? 'Adding' : 'Updating'} flow with ID: ${flow.id}`);
      
      try {
        const result = await flowAdapter.saveFlow(flow as Flow);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true,
          flow: result.flow
        });
      } catch (error) {
        log.error(`POST: Error ${action === 'addFlow' ? 'adding' : 'updating'} flow:`, error);
        return NextResponse.json({ 
          error: `Error ${action === 'addFlow' ? 'adding' : 'updating'} flow: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Delete a flow
    else if (action === 'deleteFlow') {
      const { id } = body;
      
      if (!id) {
        return NextResponse.json({ error: 'Flow ID is required' }, { status: 400 });
      }
      
      log.debug(`POST: Deleting flow with ID: ${id}`);
      
      try {
        const result = await flowAdapter.deleteFlow(id);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true
        });
      } catch (error) {
        log.error('POST: Error deleting flow:', error);
        return NextResponse.json({ 
          error: `Error deleting flow: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Create a new flow
    else if (action === 'createNewFlow') {
      const { name } = body;
      
      log.debug(`POST: Creating new flow with name: ${name || 'NewFlow'}`);
      
      try {
        const flow = flowAdapter.createNewFlow(name);
        
        return NextResponse.json({
          success: true,
          flow
        });
      } catch (error) {
        log.error('POST: Error creating new flow:', error);
        return NextResponse.json({ 
          error: `Error creating new flow: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Generate a sample flow
    else if (action === 'generateSampleFlow') {
      const { name } = body;
      
      log.debug(`POST: Generating sample flow with name: ${name || 'Sample Flow'}`);
      
      try {
        const flow = flowAdapter.generateSampleFlow(name);
        
        return NextResponse.json({
          success: true,
          flow
        });
      } catch (error) {
        log.error('POST: Error generating sample flow:', error);
        return NextResponse.json({ 
          error: `Error generating sample flow: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('POST: Flow API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}
