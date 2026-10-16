// Retained for release preflight. These are synthetic storage regressions.
import { admitPausedPersonaGoal, readPersonaGoalAdmission } from '@/backend/services/enduringAgents/goalAdmission';
import { reconcilePersonaGoals } from '@/backend/services/enduringAgents/goalRuntime';
import { getPersonaWorkItem, listPersonaFlowDispatches, listPersonaWorkItems } from '@/backend/services/enduringAgents';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

it('saves a native root paused before scheduler observation and reconciles one exact intent', async () => {
  await runWithWorkspace(`paused-admission-${process.pid}`, async () => {
    const { persona } = await createPersonaFromRole({ name: 'Synthetic admission', idempotencyKey: 'paused-admission' });
    const key = 'a'.repeat(64);
    const input = { title: 'Original case', description: 'Synthetic original-case correlation',
      successCriteria: 'Return reviewed original-case evidence; no bank write authority.' };
    const [first, duplicate] = await Promise.all([
      admitPausedPersonaGoal(persona.id, key, input), admitPausedPersonaGoal(persona.id, key, input),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.goal).toMatchObject({ state: 'paused', rounds: 0 });
    const item = await getPersonaWorkItem(persona.id, first.goal.id);
    expect(item?.goal?.nextRunAt).toBeUndefined();
    await reconcilePersonaGoals(persona.id);
    expect(await listPersonaFlowDispatches(persona.id)).toHaveLength(0);
    expect(await listPersonaWorkItems(persona.id)).toHaveLength(1);
    expect(await readPersonaGoalAdmission(persona.id, key)).toEqual(first);
    await expect(admitPausedPersonaGoal(persona.id, key, { ...input, successCriteria: 'Different intent' }))
      .rejects.toThrow('different Goal intent');
    expect(await readPersonaGoalAdmission(persona.id, 'b'.repeat(64))).toBeNull();
  });
});
