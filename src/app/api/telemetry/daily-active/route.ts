import { NextRequest, NextResponse } from 'next/server';
import { checkDailyActivity } from '@/backend/services/telemetry';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/telemetry/daily-active/route');

export const dynamic = 'force-dynamic';

/**
 * Runs the local daily check. This route never accepts telemetry fields from
 * the browser: the backend constructs the fixed, allowlisted payload itself.
 */
export async function POST(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    return NextResponse.json(await checkDailyActivity());
  } catch (error) {
    // Storage failure is reported to the local UI, but telemetry remains
    // non-essential and must not disturb the rest of the application.
    log.warn('Daily telemetry check failed locally', error);
    return NextResponse.json(
      {
        enabled: true,
        attempted: false,
        sent: false,
        shouldNotify: false,
      },
      { status: 200 },
    );
  }
}
