import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import {
  claimNextPersonaActivity,
  commitPersonaActivityMutation,
  commitWithPersonaActivityLease,
  completePersonaActivity,
  routePersonaMailboxItem,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents/activityRuntime';
import { reportPersonaActivityOutcome } from '@/backend/services/enduringAgents/activityOutcomes';
import { getPersonaActivity, getPersonaLease } from '@/backend/services/enduringAgents/store';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

function fenceFor(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.lease.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function authorityFor(fence: PersonaLeaseFence): FlowExecutionAuthority {
  return {
    signal: new AbortController().signal,
    assertCurrent: () => commitWithPersonaActivityLease(fence, async () => undefined),
    commitPersonaMutation: (task) => commitPersonaActivityMutation(fence, task),
  };
}

let sequence = 0;
async function withRunningActivity(task: (claim: PersonaActivityClaim, authority: FlowExecutionAuthority) => Promise<void>) {
  return runWithWorkspace(`activity-report-${process.pid}-${++sequence}`, async () => {
    const { persona } = await createPersonaFromRole({ name: 'Frederik', idempotencyKey: 'report-test' });
    await routePersonaMailboxItem({
      personaId: persona.id,
      idempotencyKey: 'report-task',
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'task-report' },
      summary: 'Research and verify campaign progress',
    });
    const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 30_000 });
    if (!claim) throw new Error('Expected a running Activity.');
    const fence = fenceFor(claim);
    try {
      await task(claim, authorityFor(fence));
    } finally {
      const current = await getPersonaActivity(persona.id, claim.activity.id);
      if (current?.status === 'running') await completePersonaActivity({ ...fence, status: 'cancelled' });
    }
  });
}

describe('fenced native Activity reports', () => {
  it('persists verified progress without ending the Activity and retains it on normal completion', async () => {
    await withRunningActivity(async (claim, executionAuthority) => {
      const report = await reportPersonaActivityOutcome(claim.activity.personaId, claim.activity.id, {
        resolution: 'partial',
        summary: 'Saved research.md with three verified sources.',
        nextAction: 'Prepare a draft using those sources.',
        goalAchieved: false,
        retryAfterMs: 60_000,
      }, { executionAuthority });
      expect(report).toMatchObject({
        decisionSource: 'persona_claim',
        evidenceRefs: [{ kind: 'activity', id: claim.activity.id }],
      });
      expect(await getPersonaActivity(claim.activity.personaId, claim.activity.id)).toMatchObject({ status: 'running', reportedOutcome: report });
      expect(await getPersonaLease(claim.activity.personaId)).toMatchObject({ status: 'active' });
      const completed = await completePersonaActivity({ ...fenceFor(claim), status: 'completed' });
      expect(completed.activity.outcome).toEqual(report);
      expect(completed.activity.reportedOutcome).toBeUndefined();
    });
  });

  it('rejects missing authority, foreign ownership and malformed progress without writing', async () => {
    await withRunningActivity(async (claim, executionAuthority) => {
      const input = { resolution: 'succeeded' as const, summary: 'Verified result.' };
      await expect(reportPersonaActivityOutcome(claim.activity.personaId, claim.activity.id, input, {})).rejects.toThrow('live execution authority');
      await expect(reportPersonaActivityOutcome(claim.activity.personaId, 'another_activity', input, { executionAuthority })).rejects.toThrow('owning running Activity');
      await expect(reportPersonaActivityOutcome(claim.activity.personaId, claim.activity.id, {
        resolution: 'partial', summary: 'Unfinished work.', goalAchieved: true,
      }, { executionAuthority })).rejects.toThrow();
      expect((await getPersonaActivity(claim.activity.personaId, claim.activity.id))?.outcome).toBeUndefined();
    });
  });

  it('does not preserve reported success after an error and rejects a stale reporting worker', async () => {
    await withRunningActivity(async (claim, executionAuthority) => {
      const input = { resolution: 'succeeded' as const, summary: 'Verified result.', goalAchieved: true };
      await reportPersonaActivityOutcome(claim.activity.personaId, claim.activity.id, input, { executionAuthority });
      const completed = await completePersonaActivity({ ...fenceFor(claim), status: 'error', error: 'Later tool execution failed.' });
      expect(completed.activity.outcome).toMatchObject({ resolution: 'failed', decisionSource: 'engine' });
      expect(completed.activity.outcome?.goalAchieved).toBeUndefined();
      await expect(reportPersonaActivityOutcome(claim.activity.personaId, claim.activity.id, input, { executionAuthority })).rejects.toThrow();
      expect((await getPersonaActivity(claim.activity.personaId, claim.activity.id))?.outcome).toEqual(completed.activity.outcome);
    });
  });
});
