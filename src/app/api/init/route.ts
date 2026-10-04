import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { ensureBackendInitialized, onUnlocked } from '@/backend/init';
import { isEncryptionLocked } from '@/utils/encryption/secure';

const log = createLogger('app/api/init/route');

/**
 * API route for application initialization.
 *
 * Backend initialization is normally triggered server-side at process startup
 * by the instrumentation hook (src/instrumentation.ts), so the app no longer
 * depends on the frontend calling this. This route remains as an idempotent
 * fallback / explicit re-trigger. Locked boot settles its initialization memo
 * before secret-dependent services start. After unlock, join the separate
 * memoized service startup before reporting initialized to the caller.
 */
async function GET_handler(req: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling initialization request [RequestID: ${requestId}]`);

  try {
    await ensureBackendInitialized();
    if (!(await isEncryptionLocked())) await onUnlocked();

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

export const GET = withWorkspaceRoute(GET_handler);
