import {
  PersonaDraftConflictError,
  createPersonaCreationDraft,
  deletePersonaCreationDraft,
  getPersonaCreationDraft,
  listPersonaCreationDrafts,
  listPersonas,
  updatePersonaCreationDraft,
} from '@/backend/services/enduringAgents';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function workspaceId(label: string): string {
  workspaceSequence += 1;
  return `persona-drafts-${label}-${process.pid}-${workspaceSequence}`;
}

const payload = {
  step: 2,
  name: '',
  mission: 'Help later',
  avatarUrl: '',
  roleVersionId: '',
  coreFlowRef: '',
  behaviorFlowRefs: [],
  appRefs: [],
  appsEdited: false,
  memories: ['A fact saved before the Persona is complete.'],
  idempotencyKey: 'draft-final-create-key',
};

describe('Persona creation drafts', () => {
  it('persists incomplete data without creating runtime Persona records', async () => {
    await runWithWorkspace(workspaceId('incomplete'), async () => {
      const draft = await createPersonaCreationDraft({
        id: 'draft_incomplete',
        payload,
      });

      expect(draft).toMatchObject({
        id: 'draft_incomplete',
        status: 'draft',
        revision: 1,
        payload,
      });
      expect(await listPersonaCreationDrafts()).toEqual([draft]);
      expect(await listPersonas()).toEqual([]);
    });
  });

  it('makes create and update retries idempotent and rejects stale writes', async () => {
    await runWithWorkspace(workspaceId('revision'), async () => {
      const created = await createPersonaCreationDraft({
        id: 'draft_revision',
        payload,
      });
      await expect(createPersonaCreationDraft({
        id: 'draft_revision',
        payload,
      })).resolves.toEqual(created);

      const nextPayload = { ...payload, name: 'Mina' };
      const updated = await updatePersonaCreationDraft(created.id, {
        expectedRevision: created.revision,
        payload: nextPayload,
      });
      expect(updated.revision).toBe(2);

      await expect(updatePersonaCreationDraft(created.id, {
        expectedRevision: created.revision,
        payload: nextPayload,
      })).resolves.toEqual(updated);
      await expect(updatePersonaCreationDraft(created.id, {
        expectedRevision: created.revision,
        payload: { ...nextPayload, mission: 'Stale overwrite' },
      })).rejects.toBeInstanceOf(PersonaDraftConflictError);
    });
  });

  it('isolates drafts by workspace and discards only the selected record', async () => {
    const firstWorkspace = workspaceId('first');
    const secondWorkspace = workspaceId('second');

    const first = await runWithWorkspace(firstWorkspace, () => (
      createPersonaCreationDraft({ id: 'draft_shared_id', payload })
    ));
    const second = await runWithWorkspace(secondWorkspace, async () => {
      expect(await getPersonaCreationDraft(first.id)).toBeNull();
      const created = await createPersonaCreationDraft({
        id: first.id,
        payload: { ...payload, name: 'Other workspace' },
      });
      expect(created.workspaceId).toBe(secondWorkspace);
      expect(await listPersonaCreationDrafts()).toEqual([created]);
      return created;
    });

    await runWithWorkspace(firstWorkspace, async () => {
      expect((await getPersonaCreationDraft(first.id))?.payload.name).toBe('');
      await deletePersonaCreationDraft(first.id, {
        expectedRevision: first.revision,
      });
      expect(await getPersonaCreationDraft(first.id)).toBeNull();
      expect(await listPersonaCreationDrafts()).toEqual([]);
    });
    await runWithWorkspace(secondWorkspace, async () => {
      const updated = await updatePersonaCreationDraft(second.id, {
        expectedRevision: second.revision,
        payload: { ...second.payload, mission: 'Updated only in workspace two' },
      });
      expect(updated.payload).toMatchObject({
        name: 'Other workspace',
        mission: 'Updated only in workspace two',
      });
      expect(await listPersonaCreationDrafts()).toEqual([updated]);
    });
  });

  it('rejects malformed values that are present', async () => {
    await runWithWorkspace(workspaceId('invalid'), async () => {
      await expect(createPersonaCreationDraft({
        id: 'draft_invalid',
        payload: { ...payload, avatarUrl: 'file:///private/avatar.png' },
      })).rejects.toThrow();
    });
  });
});
