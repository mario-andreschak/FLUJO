import { promises as fs } from 'fs';
import path from 'path';

import {
  PersonaDeletionConflictError,
  assertPersonaActivityLease,
  claimNextPersonaActivity,
  createPersonaFromRole,
  deletePersona,
  enqueuePersonaMailboxItem,
  previewPersonaDeletion,
} from '@/backend/services/enduringAgents';
import {
  getPersona,
  getPersonaDeletionTombstone,
  getRoleVersion,
  listBehaviorBindings,
  listBehaviorRevisions,
  listMemoryItems,
  listPersonaActivities,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  listPersonaWorkItems,
  savePersonaDeletionTombstone,
} from '@/backend/services/enduringAgents/store';
import { personaDeletionTombstoneId } from '@/backend/services/enduringAgents/ids';
import { getPersonaHome, inspectPersonaHome } from '@/backend/services/enduringAgents/namespaces';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  type PersonaDeletionArchivePolicy,
} from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function freshWorkspace(): string {
  workspaceSequence += 1;
  return `enduring-delete-${process.pid}-${workspaceSequence}`;
}

function confirmation(
  previewToken: string,
  archivePolicy: PersonaDeletionArchivePolicy = 'anonymize',
) {
  return { previewToken, archivePolicy, confirmation: 'DELETE' as const };
}

describe('Persona deletion policy', () => {
  it('previews every owned category without deleting shared Role or MCP configuration', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const bundle = await createPersonaFromRole({
        id: 'jim_preview',
        name: 'Jim',
        initialMemories: [{ content: 'The user prefers focused status updates.' }],
      });
      const home = getPersonaHome(bundle.persona.id);
      await fs.mkdir(path.join(home, 'notes'), { recursive: true });
      await fs.writeFile(path.join(home, 'notes', 'private.txt'), 'private');

      const first = await previewPersonaDeletion(bundle.persona.id);
      const second = await previewPersonaDeletion(bundle.persona.id);

      expect(first.previewToken).toBe(second.previewToken);
      expect(first).toMatchObject({
        personaId: bundle.persona.id,
        activeLease: false,
        homeExists: true,
        counts: {
          behaviorBindings: 2,
          behaviorRevisions: 2,
          memoryItems: 1,
          homeFiles: 1,
          homeBytes: 7,
        },
        externalSharedResources: { action: 'retained' },
        backupPolicy: {
          action: 'retained_until_workspace_backup_expiry',
          immediatePurgeSupported: false,
        },
      });
      expect(first.externalSharedResources.mcpConfigNames).toEqual([]);
    });
  });

  it('rejects stale confirmation and preserves the Persona', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_stale', name: 'Jim' });
      const preview = await previewPersonaDeletion(persona.id);
      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'new-after-preview',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'ticket-1' },
        summary: 'New work after preview',
      });

      await expect(deletePersona(persona.id, confirmation(preview.previewToken)))
        .rejects.toBeInstanceOf(PersonaDeletionConflictError);
      expect(await getPersona(persona.id)).not.toBeNull();
      expect(await getPersonaDeletionTombstone(persona.id)).toBeNull();
    });
  });

  it('fails admission closed after the durable deleting marker, even before quiescence', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_crash_prefix', name: 'Jim' });
      const preview = await previewPersonaDeletion(persona.id);
      const now = Date.now();
      await savePersonaDeletionTombstone({
        schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
        id: personaDeletionTombstoneId(preview.workspaceId, persona.id),
        workspaceId: preview.workspaceId,
        personaIdHash: 'e'.repeat(64),
        status: 'deleting',
        archivePolicy: 'anonymize',
        previewToken: preview.previewToken,
        counts: preview.counts,
        requestedAt: now,
        updatedAt: now,
      });

      await expect(enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'must-not-admit',
        kind: 'assignment',
        source: { kind: 'assignment' },
      })).rejects.toThrow(/pending deletion/i);
      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 }))
        .rejects.toThrow(/pending deletion/i);
      expect(await listPersonaMailboxItems(persona.id)).toEqual([]);
    });
  });

  it('revokes active authority, erases private state, retains shared Roles, and prevents resurrection', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const bundle = await createPersonaFromRole({
        id: 'jim_delete',
        name: 'Jim',
        initialMemories: [{ content: 'A private fact.' }],
      });
      const personaId = bundle.persona.id;
      await enqueuePersonaMailboxItem({
        personaId,
        idempotencyKey: 'active-assignment',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'ticket-2' },
      });
      const claim = await claimNextPersonaActivity({ personaId, ttlMs: 60_000 });
      expect(claim).not.toBeNull();
      const preview = await previewPersonaDeletion(personaId);
      expect(preview.activeLease).toBe(true);

      const tombstone = await deletePersona(personaId, confirmation(preview.previewToken));
      expect(tombstone).toMatchObject({
        status: 'completed',
        archivePolicy: 'anonymize',
      });
      expect(tombstone.retainedPersonaId).toBeUndefined();
      expect(tombstone.personaIdHash).toHaveLength(64);

      expect(await getPersona(personaId)).toBeNull();
      expect(await listBehaviorBindings(personaId)).toEqual([]);
      expect(await listBehaviorRevisions(personaId)).toEqual([]);
      expect(await listMemoryItems(personaId)).toEqual([]);
      expect(await listPersonaWorkItems(personaId)).toEqual([]);
      expect(await listPersonaActivities(personaId)).toEqual([]);
      expect(await listPersonaMailboxItems(personaId)).toEqual([]);
      expect(await listPersonaLeaseRecords(personaId)).toEqual([]);
      expect(await inspectPersonaHome(personaId)).toEqual({
        exists: false,
        fileCount: 0,
        totalBytes: 0,
      });
      expect(await getRoleVersion(bundle.persona.roleVersionId)).not.toBeNull();

      await expect(assertPersonaActivityLease({
        workspaceId: claim!.lease.workspaceId,
        personaId,
        activityId: claim!.activity.id,
        leaseId: claim!.lease.id,
        holderId: claim!.lease.holderId,
        fencingToken: claim!.lease.fencingToken,
      })).rejects.toThrow();
      await expect(createPersonaFromRole({ id: personaId, name: 'Jim' }))
        .rejects.toThrow(/deleted and cannot be recreated/i);
      expect((await inspectPersonaHome(personaId)).exists).toBe(false);

      // Exact retries are idempotent after a crash or lost HTTP response.
      await expect(deletePersona(personaId, confirmation(preview.previewToken)))
        .resolves.toEqual(tombstone);
    });
  });

  it('keeps deletion tombstones and live Personas isolated by workspace', async () => {
    const workspaceA = freshWorkspace();
    const workspaceB = freshWorkspace();
    const personaId = 'jim_workspace_scoped';

    await runWithWorkspace(workspaceA, async () => {
      await createPersonaFromRole({ id: personaId, name: 'Jim A' });
    });
    await runWithWorkspace(workspaceB, async () => {
      await createPersonaFromRole({ id: personaId, name: 'Jim B' });
    });

    await runWithWorkspace(workspaceA, async () => {
      const preview = await previewPersonaDeletion(personaId);
      const deleted = await deletePersona(
        personaId,
        confirmation(preview.previewToken, 'retain_tombstone'),
      );
      expect(deleted.retainedPersonaId).toBe(personaId);
      expect(await getPersona(personaId)).toBeNull();
    });

    await runWithWorkspace(workspaceB, async () => {
      expect(await getPersona(personaId)).toMatchObject({ name: 'Jim B' });
      expect(await getPersonaDeletionTombstone(personaId)).toBeNull();
    });
  });
});
