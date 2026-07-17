import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { ensureBackendInitialized } from '@/backend/init';
import { json } from '../_helpers';

const log = createLogger('app/api/planned-executions/reconcile/route');

/**
 * POST /api/planned-executions/reconcile
 *
 * Force the scheduler to re-arm every trigger and run schedule catch-up
 * evaluation, WITHOUT changing the global pause state (issue #113). Previously
 * the only external way to trigger this was `PATCH /api/planned-executions
 * { paused: false }`, which also unpauses — semantic overload for a control
 * plane that resumes a suspended instance and merely wants missed crons to
 * catch up.
 *
 * `reconcile()` is idempotent and serialized; if the scheduler is currently
 * paused it no-ops arming, so the response echoes the pause state to tell the
 * caller nothing was armed.
 */
export async function POST() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    // Ensure the scheduler singleton is booted (idempotent) so a reconcile hit
    // right after startup operates on the real armed set.
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
    const scheduler = getSchedulerService();
    await scheduler.reconcile();
    const paused = await scheduler.isPaused();
    return json({ ok: true, paused }, 200);
  } catch (error) {
    log.error('Error handling POST reconcile request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
