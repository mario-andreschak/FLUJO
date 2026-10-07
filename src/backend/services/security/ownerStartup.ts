import { getExposureMode } from '@/utils/http/exposureMode';
import { readOwnerPolicy } from './ownerPolicy';

const recovery = 'Owner authentication is required for Network/Public exposure. '
  + 'Restart with FLUJO_EXPOSURE_MODE=localhost, configure a private FLUJO_OWNER_AUTH_FILE '
  + 'with an active owner credential, then enable broader exposure.';

/** Run before startup initialization; exposure and worker authority stay distinct. */
export function assertOwnerStartup(now = Date.now()): void {
  if (process.env.FLUJO_WORKER_MODE === '1') {
    if (!process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim()) {
      throw new Error('Worker startup requires FLUJO_SNAPSHOT_CONTROL_TOKEN. Configure the dedicated worker bearer before restarting.');
    }
    return;
  }
  const configured = process.env.FLUJO_OWNER_AUTH_FILE;
  if (configured === undefined && getExposureMode() === 'localhost') return;
  try {
    if (configured === undefined || !Number.isSafeInteger(now) || now < 0) throw new Error('Missing owner authority');
    const policy = readOwnerPolicy(configured.trim());
    if (!policy.credentials.some(record => record.revokedAt === null
      && record.issuedAt <= now && record.expiresAt > now)) throw new Error('Inactive owner authority');
  } catch { throw new Error(recovery); }
}
