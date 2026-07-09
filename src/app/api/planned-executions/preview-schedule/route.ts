import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { validateSchedule, scheduleNextRuns } from '@/backend/services/scheduler/triggers/schedule';
import { json } from '../_helpers';

const log = createLogger('app/api/planned-executions/preview-schedule/route');

/**
 * POST /api/planned-executions/preview-schedule
 * Validate a cron pattern and preview upcoming fire times, for the editor UI.
 * Body: { cron: string, timezone?: string }
 * Response: { valid: boolean, error?: string, nextRuns: string[] }
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = await request.json();
    const cron = typeof body?.cron === 'string' ? body.cron : '';
    const timezone = typeof body?.timezone === 'string' && body.timezone ? body.timezone : undefined;
    if (!cron.trim()) {
      return json({ valid: false, error: 'A cron pattern is required', nextRuns: [] }, 200);
    }
    const result = validateSchedule(cron, timezone);
    if (!result.valid) {
      return json({ valid: false, error: result.error, nextRuns: [] }, 200);
    }
    return json({ valid: true, nextRuns: scheduleNextRuns(cron, timezone, 3) }, 200);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
