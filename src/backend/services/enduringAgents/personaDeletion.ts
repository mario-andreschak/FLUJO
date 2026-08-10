import { createHash } from 'crypto';

import {
  DeletePersonaInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  PersonaDeletionTombstoneSchema,
  type BehaviorRevision,
  type DeletePersonaInput,
  type PersonaDeletionCounts,
  type PersonaDeletionPreview,
  type PersonaDeletionTombstone,
} from '@/shared/types/enduringAgent';
import { deleteCollectionItem } from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  deletePersonaRuntimeRecoveryReceipt,
  listPersonaRuntimeRecoveryReceipts,
  quiescePersonaForDeletionWithinRuntimeLock,
} from './activityRuntime';
import { canonicalJson } from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { personaDeletionTombstoneId } from './ids';
import { deletePersonaHome, inspectPersonaHome } from './namespaces';
import { listPersonaFlowDispatches } from './personaDispatcher';
import { withPersonaRuntimeLock } from './runtimeLock';
import { deletePersonaRuntimeEvents } from './runtimeEvents';
import {
  getPersona,
  getPersonaDeletionTombstone,
  getPersonaLease,
  listBehaviorBindings,
  listBehaviorRevisions,
  listMemoryItems,
  listPersonaActivities,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  listPersonaWorkItems,
  savePersonaDeletionTombstone,
} from './store';

export class PersonaDeletionNotFoundError extends Error {
  readonly code = 'PERSONA_DELETION_NOT_FOUND' as const;

  constructor(readonly personaId: string) {
    super(`Persona ${JSON.stringify(personaId)} not found in this workspace.`);
    this.name = 'PersonaDeletionNotFoundError';
  }
}

export class PersonaDeletionConflictError extends Error {
  readonly code = 'PERSONA_DELETION_CONFLICT' as const;

  constructor(readonly personaId: string, message: string) {
    super(message);
    this.name = 'PersonaDeletionConflictError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function referencedMcpConfigs(revisions: BehaviorRevision[]): string[] {
  const names = new Set<string>();
  for (const revision of revisions) {
    for (const node of revision.flowSnapshot.nodes) {
      const properties = node.data.properties;
      const boundServer = properties && typeof properties === 'object'
        ? (properties as Record<string, unknown>).boundServer
        : undefined;
      if (typeof boundServer === 'string' && boundServer.trim()) names.add(boundServer.trim());
    }
  }
  return [...names].sort();
}

async function buildPreview(personaId: string): Promise<PersonaDeletionPreview> {
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaDeletionNotFoundError(personaId);

  const [
    behaviorBindings,
    behaviorRevisions,
    memoryItems,
    workItems,
    activities,
    mailboxItems,
    flowDispatches,
    runtimeRecoveryReceipts,
    lease,
    leaseRecords,
    home,
  ] = await Promise.all([
    listBehaviorBindings(personaId),
    listBehaviorRevisions(personaId),
    listMemoryItems(personaId),
    listPersonaWorkItems(personaId),
    listPersonaActivities(personaId),
    listPersonaMailboxItems(personaId),
    listPersonaFlowDispatches(personaId),
    listPersonaRuntimeRecoveryReceipts(personaId),
    getPersonaLease(personaId),
    listPersonaLeaseRecords(personaId),
    inspectPersonaHome(personaId),
  ]);

  const terminalActivity = (status: string) => (
    status === 'completed' || status === 'cancelled' || status === 'error'
  );
  const terminalMailbox = (status: string) => (
    status === 'coalesced' || status === 'completed' || status === 'rejected'
  );
  const archivedActivities = activities.filter((item) => terminalActivity(item.status)).length;
  const archivedMailboxItems = mailboxItems.filter((item) => terminalMailbox(item.status)).length;
  const counts: PersonaDeletionCounts = {
    behaviorBindings: behaviorBindings.length,
    behaviorRevisions: behaviorRevisions.length,
    memoryItems: memoryItems.length,
    workItems: workItems.length,
    liveActivities: activities.length - archivedActivities,
    archivedActivities,
    openMailboxItems: mailboxItems.length - archivedMailboxItems,
    archivedMailboxItems,
    leaseRecords: leaseRecords.length,
    coreMemoryItems: (persona.coreMemoryItemIds ?? []).length,
    homeFiles: home.fileCount,
    homeBytes: home.totalBytes,
  };

  const fingerprint = {
    workspaceId: getCurrentWorkspace(),
    persona: { id: persona.id, updatedAt: persona.updatedAt, state: persona.lifecycleState },
    behaviorBindings: behaviorBindings.map((item) => [item.id, item.updatedAt]),
    behaviorRevisions: behaviorRevisions.map((item) => [item.id, item.createdAt]),
    memoryItems: memoryItems.map((item) => [item.id, item.updatedAt, item.status]),
    workItems: workItems.map((item) => [item.id, item.updatedAt, item.status]),
    activities: activities.map((item) => [item.id, item.updatedAt, item.status]),
    mailboxItems: mailboxItems.map((item) => [item.id, item.updatedAt, item.status]),
    flowDispatches: flowDispatches.map((item) => [item.id, item.updatedAt, item.state]),
    runtimeRecoveryReceipts: runtimeRecoveryReceipts.map((item) => [
      item.id,
      item.updatedAt,
      item.result.lifecycleState,
    ]),
    lease: lease ? [lease.id, lease.fencingToken, lease.renewedAt, lease.status] : null,
    leaseRecords: leaseRecords.map((item) => [item.id, item.fencingToken, item.status]),
    home,
  };

  return {
    personaId,
    workspaceId: getCurrentWorkspace(),
    generatedAt: Date.now(),
    previewToken: sha256(canonicalJson(fingerprint)),
    counts,
    activeLease: lease?.status === 'active',
    homeExists: home.exists,
    referencedArchiveEvidence: {
      activities: archivedActivities,
      mailboxItems: archivedMailboxItems,
      futureCrossSystemAttributionPolicy: 'anonymize_or_minimal_tombstone',
    },
    externalSharedResources: {
      mcpConfigNames: referencedMcpConfigs(behaviorRevisions),
      action: 'retained',
    },
    backupPolicy: {
      action: 'retained_until_workspace_backup_expiry',
      immediatePurgeSupported: false,
    },
  };
}

export async function previewPersonaDeletion(personaId: string): Promise<PersonaDeletionPreview> {
  EnduringAgentIdSchema.parse(personaId);
  return withPersonaRuntimeLock(personaId, async () => buildPreview(personaId));
}

async function erasePersonaOwnedState(personaId: string): Promise<void> {
  const [
    behaviorBindings,
    behaviorRevisions,
    memoryItems,
    workItems,
    activities,
    mailboxItems,
    flowDispatches,
    runtimeRecoveryReceipts,
    leaseRecords,
  ] = await Promise.all([
    listBehaviorBindings(personaId),
    listBehaviorRevisions(personaId),
    listMemoryItems(personaId),
    listPersonaWorkItems(personaId),
    listPersonaActivities(personaId),
    listPersonaMailboxItems(personaId),
    listPersonaFlowDispatches(personaId),
    listPersonaRuntimeRecoveryReceipts(personaId),
    listPersonaLeaseRecords(personaId),
  ]);

  // Remove the living actor first. The already-durable tombstone prevents the
  // deterministic factory from resurrecting the id while erasure continues.
  await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, personaId);
  await Promise.all([
    ...behaviorBindings.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorBindings,
      item.id,
    )),
    ...behaviorRevisions.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorRevisions,
      item.id,
    )),
    ...memoryItems.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.memoryItems,
      item.id,
    )),
    ...workItems.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.workItems,
      item.id,
    )),
    ...activities.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.activities,
      item.id,
    )),
    ...mailboxItems.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.mailboxItems,
      item.id,
    )),
    ...flowDispatches.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.flowDispatches,
      item.id,
    )),
    ...runtimeRecoveryReceipts.map((item) => deletePersonaRuntimeRecoveryReceipt(item.id)),
    ...leaseRecords.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.leaseHistory,
      item.id,
    )),
    deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, personaId),
    deletePersonaRuntimeEvents(personaId),
    deletePersonaHome(personaId),
  ]);
}

export async function deletePersona(
  personaId: string,
  value: unknown,
): Promise<PersonaDeletionTombstone> {
  EnduringAgentIdSchema.parse(personaId);
  const input = DeletePersonaInputSchema.parse(value) as DeletePersonaInput;

  return withPersonaRuntimeLock(personaId, async (lock) => {
    const existing = await getPersonaDeletionTombstone(personaId);
    if (existing) {
      if (
        existing.previewToken !== input.previewToken
        || existing.archivePolicy !== input.archivePolicy
      ) {
        throw new PersonaDeletionConflictError(
          personaId,
          'Deletion is already recorded with a different preview or archive policy.',
        );
      }
      if (existing.status === 'completed') return existing;
    }

    let tombstone = existing;
    if (!tombstone) {
      const preview = await buildPreview(personaId);
      if (preview.previewToken !== input.previewToken) {
        throw new PersonaDeletionConflictError(
          personaId,
          'Persona state changed after the deletion preview; inspect and confirm again.',
        );
      }
      const now = Date.now();
      const workspaceId = getCurrentWorkspace();
      tombstone = PersonaDeletionTombstoneSchema.parse({
        schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
        id: personaDeletionTombstoneId(workspaceId, personaId),
        workspaceId,
        personaIdHash: sha256(`${workspaceId}\0${personaId}`),
        ...(input.archivePolicy === 'retain_tombstone' ? { retainedPersonaId: personaId } : {}),
        status: 'deleting',
        archivePolicy: input.archivePolicy,
        previewToken: preview.previewToken,
        counts: preview.counts,
        requestedAt: now,
        updatedAt: now,
      }) as PersonaDeletionTombstone;
      tombstone = await savePersonaDeletionTombstone(tombstone);
    }

    if (await getPersona(personaId)) {
      await quiescePersonaForDeletionWithinRuntimeLock(personaId, lock);
    }
    await erasePersonaOwnedState(personaId);

    const completedAt = Math.max(Date.now(), tombstone.updatedAt);
    return savePersonaDeletionTombstone(PersonaDeletionTombstoneSchema.parse({
      ...tombstone,
      status: 'completed',
      updatedAt: completedAt,
      completedAt,
    }) as PersonaDeletionTombstone);
  });
}
