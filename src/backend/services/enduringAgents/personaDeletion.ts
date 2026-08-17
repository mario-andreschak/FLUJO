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
import type { SharedState } from '@/backend/execution/flow/types';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { persistConversationSummaryStrict } from '@/backend/execution/flow/conversationSummaryStore';
import {
  deleteCollectionItem,
  loadCollectionItem,
  listCollectionItemEntriesStrict,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';
import { ticketService } from '@/backend/services/ticket';
import { anonymizeStatisticsPersonaAttribution } from '@/backend/services/statistics';
import {
  anonymizeMeetingPersonaAttribution,
  retireMeetingPersonaParticipants,
} from '@/backend/services/meetings';
import { getSchedulerService } from '@/backend/services/scheduler';

import {
  deletePersonaRuntimeRecoveryReceipt,
  listPersonaRuntimeRecoveryReceipts,
  quiescePersonaForDeletionWithinRuntimeLock,
} from './activityRuntime';
import { listBehaviorProposals } from './behaviorLearning';
import { canonicalJson } from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { removePersonaIndexEntries } from './indexing';
import { personaDeletionTombstoneId } from './ids';
import { deletePersonaHome, inspectPersonaHome } from './namespaces';
import { listPersonaFlowDispatches } from './personaDispatcher';
import { withPersonaRuntimeLock } from './runtimeLock';
import { deletePersonaRuntimeEvents } from './runtimeEvents';
import { deletePersonaEmbeddings, countPersonaEmbeddings } from './memoryEmbeddingStore';
import {
  getPersona,
  getPersonaDeletionTombstone,
  getPersonaLease,
  listBehaviorBindings,
  listBehaviorMaintenanceRuns,
  listBehaviorOutcomeMetrics,
  listBehaviorRevisions,
  listMemoryItems,
  listPersonaAppGrants,
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

function stateBelongsToPersona(state: SharedState, personaId: string): boolean {
  return state.personaAttribution?.personaId === personaId
    || state.personaTargetId === personaId
    || state.personaInstructionContext?.personaId === personaId;
}

function removeExactInstruction(text: string, instruction: string | undefined): string {
  if (!instruction || !text.includes(instruction)) return text;
  if (text === instruction) return '';
  if (text.startsWith(`${instruction}\n\n`)) {
    return text.slice(instruction.length + 2);
  }
  return text.split(instruction).join('');
}

function scrubPersonaDebugSnapshot(value: unknown, instruction: string | undefined): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === 'string') value[index] = removeExactInstruction(item, instruction);
      else scrubPersonaDebugSnapshot(item, instruction);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.personaTargetId;
  delete record.personaAttribution;
  delete record.personaInstructionContext;
  delete record.codexSessions;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') record[key] = removeExactInstruction(item, instruction);
    else scrubPersonaDebugSnapshot(item, instruction);
  }
}

/**
 * Remove identifying Persona metadata and rendered prompt copies while keeping
 * the user-visible transcript, authored Flow snapshot, evidence, and timestamps.
 * The durable archive bit preserves the original trusted-local/read-only
 * boundary without retaining an identifier.
 */
function anonymizePersonaConversationState(state: SharedState): void {
  const instruction = state.personaInstructionContext?.instruction;
  if (state.frozenSystemPrompts) {
    for (const [nodeId, prompt] of Object.entries(state.frozenSystemPrompts)) {
      state.frozenSystemPrompts[nodeId] = removeExactInstruction(prompt, instruction);
    }
  }
  if (state.executionTrace) scrubPersonaDebugSnapshot(state.executionTrace, instruction);
  delete state.personaTargetId;
  delete state.personaAttribution;
  delete state.personaInstructionContext;
  // Native provider sessions may retain the former system prompt remotely and
  // must never be resumed after the Persona identity is erased.
  delete state.codexSessions;
  delete state.executionAuthority;
  state.personaArchived = true;
}

async function anonymizePersonaConversations(personaId: string): Promise<void> {
  const entries = await listCollectionItemEntriesStrict<SharedState>('conversations');
  const liveStates = FlowExecutor.conversationStates;
  const durableIds = new Set<string>();

  for (const { id } of entries) {
    // The scan is only a candidate index. Re-read and decide while holding the
    // same lease as every conversation writer; otherwise a stale scan could
    // erase a newer archive or a concurrent writer could restore its identity.
    await withConversationExecutionLock(id, async () => {
      const current = await loadCollectionItem<SharedState | undefined>(
        'conversations',
        id,
        undefined,
      );
      if (!current) return;
      // Rebuild every prior anonymized archive too. This makes a retry complete
      // an interrupted sidecar write even though its identifying fields were
      // deliberately removed by the already-successful snapshot write.
      if (!stateBelongsToPersona(current, personaId) && !current.personaArchived) return;
      durableIds.add(id);
      const archived = structuredClone(current);
      anonymizePersonaConversationState(archived);
      await saveCollectionItem('conversations', id, archived);
      await persistConversationSummaryStrict(id, archived);

      const live = liveStates.get(id);
      if (live) anonymizePersonaConversationState(live);
    });
  }

  // Quiescence should have persisted every Persona conversation, but scrub any
  // live-only residue defensively. Do not invent a durable snapshot here.
  for (const [id] of liveStates) {
    if (durableIds.has(id)) continue;
    await withConversationExecutionLock(id, async () => {
      const state = liveStates.get(id);
      if (state && stateBelongsToPersona(state, personaId)) {
        anonymizePersonaConversationState(state);
      }
    });
  }
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
    behaviorProposals,
    behaviorMaintenanceRuns,
    behaviorOutcomeMetrics,
    appGrants,
    memoryItems,
    memoryEmbeddingsCount,
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
    listBehaviorProposals(personaId),
    listBehaviorMaintenanceRuns(personaId),
    listBehaviorOutcomeMetrics(personaId),
    listPersonaAppGrants(personaId),
    listMemoryItems(personaId),
    countPersonaEmbeddings(personaId),
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
    behaviorProposals: behaviorProposals.length,
    behaviorMaintenanceRuns: behaviorMaintenanceRuns.length,
    behaviorOutcomeMetrics: behaviorOutcomeMetrics.length,
    appGrants: appGrants.length,
    memoryItems: memoryItems.length,
    memoryEmbeddings: memoryEmbeddingsCount,
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
    behaviorProposals: behaviorProposals.map((item) => [item.id, item.updatedAt, item.status]),
    behaviorMaintenanceRuns: behaviorMaintenanceRuns.map((item) => [item.id, item.updatedAt, item.state]),
    behaviorOutcomeMetrics: behaviorOutcomeMetrics.map((item) => [
      item.id,
      item.updatedAt,
      item.verdict,
    ]),
    appGrants: appGrants.map((item) => [item.id, item.updatedAt, item.mcpServerName]),
    memoryItems: memoryItems.map((item) => [item.id, item.updatedAt, item.status]),
    memoryEmbeddingsCount,
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
      mcpConfigNames: [...new Set([
        ...referencedMcpConfigs(behaviorRevisions),
        ...appGrants.map((grant) => grant.mcpServerName),
      ])].sort(),
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
    behaviorProposals,
    behaviorMaintenanceRuns,
    behaviorOutcomeMetrics,
    appGrants,
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
    listBehaviorProposals(personaId),
    listBehaviorMaintenanceRuns(personaId),
    listBehaviorOutcomeMetrics(personaId),
    listPersonaAppGrants(personaId),
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
    ...behaviorProposals.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorProposals,
      item.id,
    )),
    ...behaviorMaintenanceRuns.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorMaintenanceRuns,
      item.id,
    )),
    ...behaviorOutcomeMetrics.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
      item.id,
    )),
    ...appGrants.map((item) => deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.appGrants,
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
    deletePersonaEmbeddings(personaId),
  ]);
  await removePersonaIndexEntries(personaId);
}

export async function deletePersona(
  personaId: string,
  value: unknown,
): Promise<PersonaDeletionTombstone> {
  EnduringAgentIdSchema.parse(personaId);
  const input = DeletePersonaInputSchema.parse(value) as DeletePersonaInput;

  // Phase one validates the confirmation, persists the retryable deletion
  // intent, and quiesces Persona-owned work under the Persona lock.
  const prepared = await withPersonaRuntimeLock(personaId, async (lock) => {
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
      if (existing.status === 'completed') {
        return { tombstone: existing, completed: true as const };
      }
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
    return { tombstone, completed: false as const };
  });

  // Meeting control locks must be acquired before any Persona Activity lock.
  // Run cross-system retirement after releasing the Persona lock so a paused
  // MeetingEngine commit cannot deadlock deletion. Advancing the meeting start
  // generation then fences every stale in-flight snapshot/event settlement.
  await Promise.all([
    retireMeetingPersonaParticipants(personaId),
    getSchedulerService().retirePersonaByPersonaId(personaId),
  ]);
  if (input.archivePolicy === 'anonymize') {
    // This is also the active-run drain barrier. Each conversation scrub waits
    // for its execution lease, so run.finished attribution cannot be appended
    // after statistics have already been anonymized.
    await anonymizePersonaConversations(personaId);
    await Promise.all([
      ticketService.clearPersonaAttributionByPersonaId(personaId),
      anonymizeStatisticsPersonaAttribution(personaId),
      anonymizeMeetingPersonaAttribution(personaId),
      getSchedulerService().anonymizePersonaAttributionByPersonaId(personaId),
    ]);
  }
  if (prepared.completed) return prepared.tombstone;

  // Phase two reacquires Persona ownership only after meeting cleanup released
  // its control locks, then irreversibly erases owned state and seals the
  // tombstone. Concurrent retries converge on the same completed record.
  return withPersonaRuntimeLock(personaId, async (lock) => {
    const current = await getPersonaDeletionTombstone(personaId);
    if (!current) {
      throw new PersonaDeletionConflictError(personaId, 'Deletion intent disappeared before completion.');
    }
    if (
      current.previewToken !== input.previewToken
      || current.archivePolicy !== input.archivePolicy
    ) {
      throw new PersonaDeletionConflictError(
        personaId,
        'Deletion is already recorded with a different preview or archive policy.',
      );
    }
    if (current.status === 'completed') return current;
    if (await getPersona(personaId)) {
      await quiescePersonaForDeletionWithinRuntimeLock(personaId, lock);
    }
    await erasePersonaOwnedState(personaId);

    const completedAt = Math.max(Date.now(), current.updatedAt);
    return savePersonaDeletionTombstone(PersonaDeletionTombstoneSchema.parse({
      ...current,
      status: 'completed',
      updatedAt: completedAt,
      completedAt,
    }) as PersonaDeletionTombstone);
  });
}
