import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import {
  claimNextPersonaActivity,
  commitPersonaActivityMutation,
  commitWithPersonaActivityLease,
  completePersonaActivity,
  createPersonaGoalWorkItem,
  routePersonaMailboxItem,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents';
import { getPersonaWorkItem, listPersonaWorkItems } from '@/backend/services/enduringAgents/store';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

let sequence = 0;

function authority(fence: PersonaLeaseFence): FlowExecutionAuthority {
  return {
    signal: new AbortController().signal,
    assertCurrent: async () => {
      await commitWithPersonaActivityLease(fence, async () => undefined);
    },
    commitPersonaMutation: (task) => commitPersonaActivityMutation(fence, task),
  };
}

it('registers one durable Goal for a caller key and reads its receipt after a lost ACK', async () => {
  await runWithWorkspace(`goal-create-${process.pid}-${++sequence}`, async () => {
    const { persona } = await createPersonaFromRole({
      name: 'Synthetic Goal owner', idempotencyKey: 'goal-create-owner',
    });
    await routePersonaMailboxItem({
      personaId: persona.id,
      idempotencyKey: 'goal-create-activity',
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'synthetic-task' },
      summary: 'Synthetic Goal creation',
    });
    const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 30_000 });
    if (!claim) throw new Error('Expected an Activity claim.');
    const fence: PersonaLeaseFence = {
      workspaceId: claim.lease.workspaceId,
      personaId: claim.lease.personaId,
      activityId: claim.activity.id,
      leaseId: claim.lease.id,
      holderId: claim.lease.holderId,
      fencingToken: claim.lease.fencingToken,
    };
    const options = { executionAuthority: authority(fence) };
    const request = {
      personaId: persona.id,
      idempotencyKey: 'synthetic-goal-create-1',
      title: 'Follow up a synthetic case',
      goal: { successCriteria: 'Record a verified next action and a terminal outcome.' },
      nextAction: 'Review the saved synthetic case.',
    };
    try {
      const first = await createPersonaGoalWorkItem(request, options);
      expect(first).toMatchObject({
        created: true,
        item: { goal: { state: 'active' }, nextAction: request.nextAction },
      });
      const repeated = await createPersonaGoalWorkItem(request, options);
      expect(repeated).toMatchObject({ created: false, item: { id: first.item.id } });
      expect((await listPersonaWorkItems(persona.id)).filter(item => item.id === first.item.id))
        .toHaveLength(1);
      expect(await getPersonaWorkItem(persona.id, first.item.id))
        .toMatchObject({ goalCreateRequestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      await expect(createPersonaGoalWorkItem({ ...request, title: 'Changed intent' }, options))
        .rejects.toThrow('Caller key already names a different Goal request');
    } finally {
      await completePersonaActivity({ ...fence, status: 'completed' });
    }
    await expect(createPersonaGoalWorkItem(request, options)).rejects.toThrow();
  });
});
