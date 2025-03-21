import { NextRequest, NextResponse } from 'next/server';
import { verifyStorage } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/init/route');

/**
 * API route for application initialization
 * This runs server-side initialization tasks
 */
export async function GET(req: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling initialization request [RequestID: ${requestId}]`);
  
  try {
    // Verify storage system
    await verifyStorage();
    
    // Start all enabled MCP servers
    log.info('Initializing MCP servers');
    await mcpService.startEnabledServers().catch(error => {
      log.error('Failed to start enabled servers:', error);
      // Make sure the flag is reset even if there's an unhandled error
      if (mcpService.isStartingUp()) {
        log.warn('Resetting startup flag after error');
        (mcpService as any).setStartingUp(false);
      }
    });
    
    return NextResponse.json({ 
      success: true,
      message: 'Application initialized successfully'
    });
  } catch (error) {
    log.error(`Initialization failed [${requestId}]:`, error);
    return NextResponse.json({ 
      success: false,
      error: `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}
