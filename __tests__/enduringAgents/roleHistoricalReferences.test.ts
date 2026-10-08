import { createPersonaFromRole, buildTestRoleDefinition, buildTestRoleVersion, TEST_ROLE_ID, TEST_ROLE_VERSION_ID } from './fixtures/personaFactory';
import { createRoleVersion, deleteRoleVersionRecord, getRoleVersion, listBehaviorRevisions, saveRoleDefinition } from '@/backend/services/enduringAgents/store';
import { updatePersonaSettings } from '@/backend/services/enduringAgents/personaAdmin';
import { hardDeletePublicRole, previewRoleImpact } from '@/backend/services/enduringAgents/roleAdmin';
import { saveCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

jest.setTimeout(60_000);
let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(`role-history-${process.pid}-${++sequence}`, task);

async function switchedPersona() {
  const { persona } = await createPersonaFromRole({ id: 'historical_role_persona', name: 'History owner' });
  await saveRoleDefinition({ ...buildTestRoleDefinition(), id: 'role_new', currentVersionId: 'rolever_new' });
  await createRoleVersion({ ...buildTestRoleVersion(), id: 'rolever_new', roleDefinitionId: 'role_new' });
  const updated = await updatePersonaSettings(persona.id, { expectedUpdatedAt: persona.updatedAt, roleVersionId: 'rolever_new' });
  expect(updated.roleVersionId).toBe('rolever_new');
  expect((await listBehaviorRevisions(persona.id)).some((revision) => revision.source.kind === 'role_template' && revision.source.roleVersionId === TEST_ROLE_VERSION_ID)).toBe(true);
  return persona;
}

it('retains Role versions used by immutable Behavior history after the Persona chooses a different Role', async () => fresh(async () => {
  const persona = await switchedPersona();
  expect(await previewRoleImpact(TEST_ROLE_ID)).toMatchObject({
    hardDeleteAllowed: false, personaIds: [persona.id], pinnedRoleVersionIds: [TEST_ROLE_VERSION_ID],
  });
  await expect(hardDeletePublicRole(TEST_ROLE_ID, { action: 'delete', expectedCurrentVersionId: TEST_ROLE_VERSION_ID })).rejects.toThrow('saved history');
  await expect(deleteRoleVersionRecord(TEST_ROLE_VERSION_ID)).rejects.toThrow('settings or history');
  expect(await getRoleVersion(TEST_ROLE_VERSION_ID)).not.toBeNull();
}));

it('does not authorize Role deletion from a partial scan when historical revision data is corrupt', async () => fresh(async () => {
  const persona = await switchedPersona();
  const revision = (await listBehaviorRevisions(persona.id))[0];
  await saveCollectionItem('behavior-revisions', revision.id, { ...revision, contentHash: '0'.repeat(64) });
  await expect(previewRoleImpact(TEST_ROLE_ID)).rejects.toThrow();
  await expect(hardDeletePublicRole(TEST_ROLE_ID, { action: 'delete', expectedCurrentVersionId: TEST_ROLE_VERSION_ID })).rejects.toThrow();
  expect(await getRoleVersion(TEST_ROLE_VERSION_ID)).not.toBeNull();
}));
