import { NextResponse } from 'next/server';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/cwd/route');

export async function GET() {
  const requestId = uuidv4();
  log.info(`Handling GET request [RequestID: ${requestId}]`);
  
  try {
    // Get the current working directory
    const cwd = process.cwd();
    log.debug(`Retrieved current working directory [${requestId}]`, cwd);
    
    // Get the mcp-servers directory path
    const mcpServersDir = path.join(cwd, 'mcp-servers');
    log.debug(`Generated mcp-servers directory path [${requestId}]`, mcpServersDir);
    
    log.info(`Returning successful response [${requestId}]`);
    return NextResponse.json({
      success: true,
      cwd,
      mcpServersDir
    });
  } catch (error) {
    log.error(`Error getting current working directory [${requestId}]`, error);
    return NextResponse.json({ 
      success: false,
      error: `Failed to get current working directory: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}
