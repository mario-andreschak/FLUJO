import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { ensureBackendInitialized } from '@/backend/init';

const log = createLogger('app/api/init/route');

/**
 * API route for application initialization.
 *
 * Backend initialization is normally triggered server-side at process startup
 * by the instrumentation hook (src/instrumentation.ts), so the app no longer
 * depends on the frontend calling this. This route remains as an idempotent
 * fallback / explicit re-trigger: ensureBackendInitialized() is memoized, so
 * calling it here simply joins the in-progress (or completed) startup run.
 */
export async function GET(req: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling initialization request [RequestID: ${requestId}]`);

  try {
    await ensureBackendInitialized();

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
