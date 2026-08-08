import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/cwd/route');

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const requestId = uuidv4();
  log.info(`Handling GET request [RequestID: ${requestId}]`);
  
  try {
    // Get the current working directory
    const cwd = process.cwd();
    log.debug(`Retrieved current working directory [${requestId}]`, cwd);
    
    // Get the mcp-servers directory path. This lives under the SELECTED
    // WORKSPACE's data dir (see utils/workspace), which sits under the data dir
    // (utils/paths) — equal to cwd for a git checkout but relocated for a
    // packaged install (npm/Docker) — so the UI reports where servers actually
    // go for the workspace the caller asked about (#406).
    const mcpServersDir = path.join(getWorkspaceDataDir(), 'mcp-servers');
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


export const GET = withWorkspaceRoute(GET_handler);
