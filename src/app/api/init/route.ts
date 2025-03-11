import { NextRequest, NextResponse } from 'next/server';
import { verifyStorage } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

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

