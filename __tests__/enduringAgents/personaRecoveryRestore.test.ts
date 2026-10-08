import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capturePersonaRecovery } from '@/backend/services/enduringAgents/personaRecoveryCapture';
import { planPersonaRecoveryRestore } from '@/backend/services/enduringAgents/personaRecoveryPlan';
import { restorePersonaRecovery, type PersonaRecoveryRestoreCheckpoint } from '@/backend/services/enduringAgents/personaRecoveryRestore';
import { validatePersonaRecoveryArchive } from '@/backend/services/enduringAgents/personaRecoveryArchive';
import { decodePersonaRecoveryZip } from '@/backend/services/enduringAgents/personaRecoveryZip';
import { deletePersona, previewPersonaDeletion } from '@/backend/services/enduringAgents/personaDeletion';
import { ENDURING_AGENT_COLLECTIONS as c } from '@/backend/services/enduringAgents/collections';
import { enqueuePersonaMailboxItem, claimNextPersonaActivity } from '@/backend/services/enduringAgents/activityRuntime';
import { createPersonaWorkItem } from '@/backend/services/enduringAgents/workItems';
import { reconcilePersonaGoals, stopPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntime';
import { reconcilePersonaFlowDispatches } from '@/backend/services/enduringAgents/personaDispatcher';
import {
  getPersona, getPersonaDeletionTombstone, listMemoryItems, listPersonaWorkItems,
  listPersonaMailboxItems, listPersonaAppGrants, listPersonaLeaseRecords,
} from '@/backend/services/enduringAgents/store';
import { saveCollectionItem, loadCollectionItem } from '@/utils/storage/backend';
import {
  createWorkspace, ensureWorkspaceDirs, getCurrentWorkspace, getWorkspaceDataDir,
  getWorkspaceDir, listWorkspaces, runWithWorkspace, workspaceExists,
} from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

jest.setTimeout(120_000);
let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(`persona-restore-${process.pid}-${++sequence}`, task);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  stopPersonaGoalRuntime();
  const { persona } = await createPersonaFromRole({ id: 'recovery_persona', name: 'Restorable Persona', initialMemories: [{ content: 'Preserve this private fact' }] });
  const goal = await createPersonaWorkItem({ personaId: persona.id, title: 'Ongoing objective', goal: { successCriteria: 'Keep a useful backlog' } });
  await enqueuePersonaMailboxItem({ personaId: persona.id, idempotencyKey: 'pending', kind: 'assignment', source: { kind: 'assignment', sourceId: 'pending' } });
  await saveCollectionItem(c.appGrants, 'grant_original', {
    schemaVersion: 1, id: 'grant_original', personaId: persona.id, mcpServerName: 'Original App', createdAt: 1, updatedAt: 1,
  });
  await saveCollectionItem('conversations', 'recovery_conversation', {
    conversationId: 'recovery_conversation', flowId: persona.composition!.coreFlowRef,
    personaTargetId: persona.id, status: 'paused_debug', messages: [],
    codexSessions: { node: { threadId: 'must-not-resume' } }, recovery: { classification: 'paused' },
  });
  const source = getCurrentWorkspace();
  const destination = `${source}-copy`;
  const capture = await capturePersonaRecovery();
  return { persona, goal, source, destination, capture };
}

describe('frozen Persona recovery publication', () => {
  it('restores supported legacy Personas without inventing an incomplete composition', async () => fresh(async () => {
    const { persona, destination } = await fixture();
    await saveCollectionItem(c.personas, persona.id, { ...persona, composition: undefined });
    const capture = await capturePersonaRecovery();
    const plan = planPersonaRecoveryRestore(capture.bytes, destination);
    await restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken);
    await runWithWorkspace(destination, async () => {
      expect(await getPersona(persona.id)).toMatchObject({ lifecycleState: 'disabled', autonomyLevel: 'locked' });
      expect((await getPersona(persona.id))?.composition).toBeUndefined();
    });
  }));
  it('preserves identity, Memory and immutable bytes, clears authority, pauses goals and keeps source evidence', async () => fresh(async () => {
    const { persona, goal, destination, capture } = await fixture();
    const plan = planPersonaRecoveryRestore(capture.bytes, destination);
    expect(plan.preview.changes).toMatchObject({ personas_disabled_and_learning_locked: 1, goals_paused: 1, conversations_made_read_only: 1 });
    expect(plan.preview.requiredAppNames).toContain('Original App');
    const result = await restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken);
    expect(result.status).toBe('restored');
    expect(await workspaceExists(destination)).toBe(true);
    const immutable = decodePersonaRecoveryZip(capture.bytes).find((file) => file.path.startsWith(`records/${c.behaviorRevisions}/`))!;
    expect(await fs.readFile(path.join(getWorkspaceDir(destination), 'db', ...immutable.path.split('/').slice(1)))).toEqual(immutable.bytes);
    expect(hash(await fs.readFile(path.join(getWorkspaceDir(destination), 'db/persona-recovery/source.zip')))).toBe(hash(capture.bytes));
    await runWithWorkspace(destination, async () => {
      expect(await getPersona(persona.id)).toMatchObject({ id: persona.id, lifecycleState: 'disabled', autonomyLevel: 'locked', composition: { appRefs: [] } });
      expect((await listMemoryItems(persona.id))[0].content).toBe('Preserve this private fact');
      expect((await listPersonaWorkItems(persona.id)).find((item) => item.id === goal.id)?.goal?.state).toBe('paused');
      expect(await listPersonaMailboxItems(persona.id)).toEqual([]);
      expect(await listPersonaAppGrants(persona.id)).toEqual([]);
      expect(await listPersonaLeaseRecords(persona.id)).toEqual([]);
      const conversation = await loadCollectionItem<Record<string, unknown>>('conversations', 'recovery_conversation', {});
      expect(conversation.personaArchived).toBe(true);
      expect(conversation.codexSessions).toBeUndefined();
      expect(conversation.recovery).toBeUndefined();
      try {
        await reconcilePersonaGoals(persona.id);
        await reconcilePersonaFlowDispatches({ waitForIdle: true });
        await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 30_000 })).rejects.toThrow('disabled');
      } finally {
        stopPersonaGoalRuntime();
      }
      expect(await listPersonaMailboxItems(persona.id)).toEqual([]);
      // A subsequent recovery retains the original private/queue evidence as an
      // opaque archive, while only the frozen current graph is executable data.
      const next = await capturePersonaRecovery();
      const inspected = validatePersonaRecoveryArchive(decodePersonaRecoveryZip(next.bytes));
      expect(inspected.manifest.counts.recoverySourceArchives).toBe(1);
      expect(inspected.files.find((file) => file.path === 'evidence/recovery-source.zip')?.bytes).toEqual(capture.bytes);
    });
    expect((await capturePersonaRecovery()).manifest.files).toEqual(capture.manifest.files);
    expect((await restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken)).status).toBe('already_restored');
  }));

  it.each<PersonaRecoveryRestoreCheckpoint>(['validated', 'file_written', 'staged', 'before_publish', 'published'])(
    'recovers an interruption at %s without publishing incomplete work', async (checkpoint) => fresh(async () => {
      const { destination, capture } = await fixture();
      const plan = planPersonaRecoveryRestore(capture.bytes, destination);
      let observed = false;
      await expect(restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken, {
        onCheckpoint: async (point) => {
          if (point !== checkpoint || observed) return;
          observed = true;
          expect((await listWorkspaces()).some((workspace) => workspace.name.startsWith('.persona-restore-'))).toBe(false);
          expect(await workspaceExists(destination)).toBe(checkpoint === 'published');
          throw new Error(`Injected ${point}`);
        },
      })).rejects.toThrow(`Injected ${checkpoint}`);
      expect(observed).toBe(true);
      expect(await workspaceExists(destination)).toBe(checkpoint === 'published');
      const result = await restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken);
      expect(result.status).toBe(checkpoint === 'published' ? 'already_restored' : 'restored');
      expect((await capturePersonaRecovery()).manifest.files).toEqual(capture.manifest.files);
    }),
  );

  it('preserves anonymous deletion tombstones across workspace names and a second recovery', async () => fresh(async () => {
    const { persona } = await createPersonaFromRole({ id: 'deleted_recovery_persona', name: 'Deleted' });
    const preview = await previewPersonaDeletion(persona.id);
    const old = await deletePersona(persona.id, { confirmation: 'DELETE', previewToken: preview.previewToken, archivePolicy: 'anonymize' });
    const destination = `${getCurrentWorkspace()}-copy`;
    const archive = await capturePersonaRecovery();
    const plan = planPersonaRecoveryRestore(archive.bytes, destination);
    await restorePersonaRecovery(archive.bytes, destination, plan.preview.previewToken);
    await runWithWorkspace(destination, async () => {
      const tombstone = await getPersonaDeletionTombstone(persona.id);
      expect(tombstone).toMatchObject({ status: 'completed', workspaceId: destination });
      expect(tombstone?.id).not.toBe(old.id);
      expect(tombstone?.retainedPersonaId).toBeUndefined();
      await expect(createPersonaFromRole({ id: persona.id, name: 'Attempted resurrection' })).rejects.toThrow('deleted');
      const second = await capturePersonaRecovery();
      const secondDestination = `${destination}-again`;
      const next = planPersonaRecoveryRestore(second.bytes, secondDestination);
      await restorePersonaRecovery(second.bytes, secondDestination, next.preview.previewToken);
      await runWithWorkspace(secondDestination, async () => {
        expect(await getPersonaDeletionTombstone(persona.id)).toMatchObject({ status: 'completed', workspaceId: secondDestination });
      });
    });
  }));

  it('rejects a stale preview and existing/case-equivalent workspace without altering it', async () => fresh(async () => {
    const { destination, capture } = await fixture();
    const plan = planPersonaRecoveryRestore(capture.bytes, destination);
    await expect(restorePersonaRecovery(capture.bytes, destination, 'wrong')).rejects.toThrow('preview changed');
    expect(await workspaceExists(destination)).toBe(false);
    await ensureWorkspaceDirs(destination.toUpperCase());
    const sentinel = path.join(getWorkspaceDir(destination.toUpperCase()), 'do-not-change.txt');
    await fs.writeFile(sentinel, 'existing workspace');
    await expect(restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken)).rejects.toThrow('case-equivalent');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('existing workspace');
    expect(() => planPersonaRecoveryRestore(capture.bytes, getCurrentWorkspace())).toThrow('new workspace name');
  }));

  it('fails closed when recovered deletion origins become empty, missing or linked', async () => fresh(async () => {
    const { persona, destination, capture } = await fixture();
    const plan = planPersonaRecoveryRestore(capture.bytes, destination);
    await restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken);
    const origin = path.join(getWorkspaceDir(destination), 'db/persona-recovery/origin.json');
    await fs.writeFile(origin, '');
    await runWithWorkspace(destination, () => expect(getPersonaDeletionTombstone(persona.id)).rejects.toThrow('origins are invalid'));
    await fs.unlink(origin);
    await runWithWorkspace(destination, () => expect(getPersonaDeletionTombstone(persona.id)).rejects.toThrow('origins are missing'));
    await fs.link(path.join(getWorkspaceDir(destination), 'db/persona-recovery/restore.json'), origin);
    await runWithWorkspace(destination, () => expect(getPersonaDeletionTombstone(persona.id)).rejects.toThrow('regular file'));
  }));

  it('serializes publication with ordinary workspace creation and converges concurrent restore submissions', async () => fresh(async () => {
    const { destination, capture } = await fixture();
    const plan = planPersonaRecoveryRestore(capture.bytes, destination);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const restore = restorePersonaRecovery(capture.bytes, destination, plan.preview.previewToken, {
      onCheckpoint: async (point) => { if (point === 'before_publish') { entered(); await hold; } },
    });
    await ready;
    const creation = createWorkspace(destination);
    const settled = Promise.allSettled([restore, creation]);
    release();
    expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    const other = `${destination}-other`;
    const otherPlan = planPersonaRecoveryRestore(capture.bytes, other);
    const results = await Promise.all([1, 2].map(() => restorePersonaRecovery(capture.bytes, other, otherPlan.preview.previewToken)));
    expect(results.map((result) => result.status).sort()).toEqual(['already_restored', 'restored']);
  }));
});
