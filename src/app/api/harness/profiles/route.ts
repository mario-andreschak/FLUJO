import { z } from 'zod';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { listHarnessProfiles, configureHarnessProfile, activateHarnessVersion } from '@/backend/services/harness/profiles';
import { harnessTargetOptions } from '@/backend/services/harness/catalog';
import { harnessQueueSummary, startHarnessWorker } from '@/backend/services/harness/worker';
import { HarnessPolicySchema, HarnessTargetSchema } from '@/shared/types/harnessIntegration';
import { harnessBody, harnessErrorResponse } from '../_helpers';

export const runtime = 'nodejs';
const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('configure'), target: HarnessTargetSchema, policy: HarnessPolicySchema, expectedUpdatedAt: z.number().optional() }).strict(),
  z.object({ action: z.literal('activate'), profileId: z.string().regex(/^[a-f0-9]{64}$/), versionId: z.string().regex(/^[a-f0-9]{64}$/), expectedUpdatedAt: z.number() }).strict(),
]);
export const GET = withWorkspaceRoute(async () => {
  const locked = await assertUnlocked(); if (locked) return locked;
  try {
    const [profiles, targets] = await Promise.all([listHarnessProfiles(), harnessTargetOptions()]);
    return Response.json({ targets, profiles: await Promise.all(profiles.map(async profile => ({ ...profile,
      versions: profile.versions.map(({ flow: _flow, ...version }) => { void _flow; return version; }),
      queue: await harnessQueueSummary(profile.id),
    }))) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return harnessErrorResponse(error); }
});
export const POST = withWorkspaceRoute(async (request: Request) => {
  const locked = await assertUnlocked(); if (locked) return locked;
  try {
    const action = Action.parse(await harnessBody(request));
    const profile = action.action === 'configure' ? await configureHarnessProfile(action.target, action.policy, action.expectedUpdatedAt)
      : await activateHarnessVersion(action.profileId, action.versionId, action.expectedUpdatedAt);
    startHarnessWorker();
    return Response.json({ id: profile.id });
  } catch (error) { return harnessErrorResponse(error); }
});
