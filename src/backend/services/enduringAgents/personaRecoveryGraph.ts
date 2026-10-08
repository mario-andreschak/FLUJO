import { PersonaRecoveryError } from './personaRecoveryError';
import { createHash } from 'crypto';
import type { Flow } from '@/shared/types/flow';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';
import { assertValidWorkspaceName } from '@/utils/workspace';
import { PERSONA_SHARDED_COLLECTIONS } from '@/utils/storage/backend';
import { BEHAVIOR_CALL_PINS_COLLECTION } from './behaviorCallPins';
import { canonicalJson, hashBehaviorFlow, hashLegacyBehaviorFlow } from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS as c } from './collections';
import { personaDeletionTombstoneId } from './ids';
import { hashPersonaInstructionContext } from './personaActivitySnapshot';
import {
  PERSONA_RECOVERY_RECORD_SPECS, validatePersonaRecoveryRecord,
  type PersonaRecoveryCollection, type ValidatedPersonaRecoveryRecord,
} from './personaRecoveryRecords';

export interface PersonaRecoveryRecordInput {
  collection: string;
  /** Actual storage filename identity; live leases are stored under personaId. */
  storageId: string;
  value: unknown;
}

type RecordValue = Record<string, unknown>;
const shardedCollections = new Set<string>(PERSONA_SHARDED_COLLECTIONS);
const recordKey = (collection: string, id: string, personaId?: string) => (
  shardedCollections.has(collection) ? `${personaId}/${id}` : id
);

export class PersonaRecoveryGraphError extends PersonaRecoveryError {
  readonly code = 'PERSONA_RECOVERY_GRAPH_INVALID';
  constructor(readonly collection: string, readonly recordId: string, reason: string) {
    super(`Cannot recover ${collection}/${recordId}: ${reason}`);
    this.name = 'PersonaRecoveryGraphError';
  }
}

/**
 * Validate relationships inside the fixed Persona record inventory without any
 * filesystem writes or runtime migration side effects. Flow/conversation/home
 * artifacts require a subsequent archive-level check; returned references are
 * obligations for that check, not evidence that those dependencies were captured.
 */
export function validatePersonaRecoveryGraph(
  inputs: readonly PersonaRecoveryRecordInput[],
  sourceWorkspace: string,
): {
  records: ValidatedPersonaRecoveryRecord[];
  flowRefs: string[];
  conversationRefs: string[];
} {
  assertValidWorkspaceName(sourceWorkspace);
  const records: ValidatedPersonaRecoveryRecord[] = [];
  const tables = new Map<PersonaRecoveryCollection, Map<string, RecordValue>>();
  const identities = new Set<string>();
  const flowRefs = new Set<string>();
  const conversationRefs = new Set<string>();
  for (const collection of Object.keys(PERSONA_RECOVERY_RECORD_SPECS) as PersonaRecoveryCollection[]) {
    tables.set(collection, new Map());
  }
  for (const input of inputs) {
    const record = validatePersonaRecoveryRecord(input.collection, input.value, sourceWorkspace);
    const fail = (reason: string): never => { throw new PersonaRecoveryGraphError(record.collection, record.id, reason); };
    const storageId = record.collection === c.leases ? record.parsed.personaId : record.id;
    if (input.storageId !== storageId) fail('storage identity does not match its record');
    const key = recordKey(record.collection, record.id, record.parsed.personaId as string | undefined);
    const identity = `${record.collection}/${key}`.toLowerCase();
    if (identities.has(identity)) fail('duplicate or case-equivalent storage identity');
    identities.add(identity);
    if (tables.get(record.collection)!.has(key)) fail('duplicate record identity');
    tables.get(record.collection)!.set(key, record.parsed);
    records.push(record);
  }
  const deletedPersonaHashes = new Set([...tables.get(c.deletionTombstones)!.values()]
    .map((item) => item.personaIdHash));

  for (const record of records) {
    const value = record.parsed;
    const owner = record.collection === c.personas ? record.id
      : typeof value.personaId === 'string' ? value.personaId : undefined;
    const fail = (reason: string): never => { throw new PersonaRecoveryGraphError(record.collection, record.id, reason); };
    const ref = (collection: PersonaRecoveryCollection, id: unknown, owned = false): RecordValue | undefined => {
      if (id === undefined) return undefined;
      const target = typeof id === 'string' ? tables.get(collection)!.get(recordKey(collection, id, owner)) : undefined;
      if (!target) return fail(`missing ${collection} reference ${JSON.stringify(id)}`);
      if (owned && target.personaId !== owner) fail(`reference ${JSON.stringify(id)} belongs to another Persona`);
      return target;
    };
    const refs = (collection: PersonaRecoveryCollection, ids: unknown, owned = false) => {
      for (const id of (ids ?? []) as string[]) ref(collection, id, owned);
    };
    const revision = (id: unknown, behaviorId: unknown = value.behaviorId): RecordValue | undefined => {
      const target = ref(c.behaviorRevisions, id, true);
      if (target && behaviorId != null && target.behaviorId !== behaviorId) {
        fail(`revision ${JSON.stringify(id)} belongs to another Behavior`);
      }
      return target;
    };
    const flow = (id: unknown) => { if (typeof id === 'string' && id) flowRefs.add(id); };
    const flowBinding = (binding: unknown) => {
      const target = binding as RecordValue | undefined;
      if (!target) return;
      // A copy's sharedFlowRef is historical provenance, not its executable dependency.
      flow(target.mode === 'persona_copy' ? target.personaFlowRef : target.sharedFlowRef);
    };
    const context = (input: unknown, activityId: unknown) => {
      if (!input) return;
      const snapshot = input as PersonaInstructionContext;
      if (snapshot.personaId !== owner || snapshot.activityId !== activityId) fail('frozen context crosses Activity ownership');
      const pinned = revision(snapshot.behaviorRevisionId, null);
      if (pinned?.contentHash !== snapshot.behaviorContentHash || pinned?.slotKey !== snapshot.behaviorSlotKey
        || (pinned?.flowSnapshot as Flow).id !== snapshot.rootFlowId) fail('frozen context does not match its immutable Behavior');
      ref(c.roleVersions, snapshot.roleVersionId);
      refs(c.memoryItems, snapshot.coreMemoryItemIds, true);
    };

    if (owner) ref(c.personas, owner);
    switch (record.collection) {
      case c.roleDefinitions: {
        const current = ref(c.roleVersions, value.currentVersionId);
        if (current && current.roleDefinitionId !== value.id) fail('current Role version belongs to another Role');
        break;
      }
      case c.roleVersions:
        ref(c.roleDefinitions, value.roleDefinitionId);
        break;
      case c.personas: {
        ref(c.roleVersions, value.roleVersionId);
        if (value.provisioningState === 'pending') fail('Persona provisioning must finish before capture');
        const personaHash = createHash('sha256').update(`${sourceWorkspace}\0${record.id}`).digest('hex');
        if (deletedPersonaHashes.has(personaHash)) {
          fail('a deletion tombstone forbids restoring this live Persona');
        }
        for (const id of (value.coreMemoryItemIds ?? []) as string[]) {
          const memory = ref(c.memoryItems, id)!;
          if (memory.personaId !== record.id || memory.status !== 'active') fail('important Memory must be active and owned by this Persona');
        }
        const composition = value.composition as RecordValue | undefined;
        if (composition) {
          flowBinding(composition.coreBinding);
          if (!composition.coreBinding) flow(composition.coreFlowRef);
          for (const id of (composition.memoryRefs ?? []) as string[]) {
            if (ref(c.memoryItems, id)?.personaId !== record.id) fail('composition Memory belongs to another Persona');
          }
          for (const behavior of (composition.behaviors ?? []) as RecordValue[]) {
            if (ref(c.behaviorBindings, behavior.ref)?.personaId !== record.id) fail('composition Behavior belongs to another Persona');
            flowBinding(behavior.binding);
            if (!behavior.binding) flow(behavior.overrideFlowRef ?? behavior.sourceFlowRef);
          }
        }
        break;
      }
      case c.personaCreationDrafts:
        // Draft fields may be incomplete or stale by design. They are preserved
        // as editable input and must pass ordinary readiness checks on resume.
        break;
      case c.behaviorBindings: {
        const active = revision(value.activeRevisionId, value.id)!;
        if (active.slotKey !== value.slotKey) fail('active revision has a different slot');
        break;
      }
      case c.behaviorRevisions: {
        const source = value.source as RecordValue;
        if (source.kind === 'role_template') ref(c.roleVersions, source.roleVersionId);
        if (source.kind === 'persona_override') {
          const parent = revision(source.parentRevisionId);
          if (parent && Number(parent.revision) >= Number(value.revision)) fail('revision parent must precede its child');
        }
        // Removed Behavior bindings may retain immutable revisions referenced by history.
        break;
      }
      case c.memoryItems:
        refs(c.memoryItems, value.supersedes, true);
        refs(c.memoryItems, value.conflictsWith, true);
        ref(c.memoryItems, value.backfillMergedInto, true);
        refs(c.memoryItems, (value.backfillMerge as RecordValue | undefined)?.memberIds, true);
        for (const resolution of (value.conflictResolutions ?? []) as RecordValue[]) {
          refs(c.memoryItems, resolution.memoryIds, true);
          ref(c.memoryItems, resolution.winnerId, true);
        }
        break;
      case c.workItems: {
        refs(c.workItems, value.dependencyIds, true);
        const parent = ref(c.workItems, value.parentGoalId, true);
        if (parent && !parent.goal) fail('parent work item is not a goal');
        ref(c.activities, value.createdByActivityId, true);
        revision(value.behaviorRevisionId);
        const goal = value.goal as RecordValue | undefined;
        ref(c.activities, goal?.lastActivityId, true);
        ref(c.workItems, goal?.pendingTaskId, true);
        ref(c.flowDispatches, goal?.pendingDispatchId, true);
        break;
      }
      case c.activities:
        revision(value.behaviorRevisionId);
        revision(value.coreFlowRevisionId);
        context(value.instructionContext, value.id);
        if (value.instructionContext && value.instructionContextDigest !== hashPersonaInstructionContext(
          value.instructionContext as unknown as PersonaInstructionContext,
        )) fail('frozen instruction digest does not match');
        if (typeof value.conversationId === 'string') conversationRefs.add(value.conversationId);
        // Lease history can be pruned under its independently verified policy.
        break;
      case BEHAVIOR_CALL_PINS_COLLECTION: {
        ref(c.activities, value.activityId, true);
        revision(value.parentBehaviorRevisionId, null);
        const pinned = revision(value.behaviorRevisionId)!;
        if (pinned.contentHash !== value.contentHash || pinned.slotKey !== value.slotKey
          || (pinned.flowSnapshot as Flow).id !== value.flowId) fail('specialist call does not match its immutable revision');
        if (value.flowSnapshot && canonicalJson(value.flowSnapshot) !== canonicalJson(pinned.flowSnapshot)) {
          fail('specialist call snapshot was changed');
        }
        break;
      }
      case c.behaviorProposals: {
        revision(value.baseBehaviorRevisionId);
        revision(value.activatedRevisionId);
        revision(value.rollbackRevisionId);
        ref(c.roleVersions, value.promotedRoleVersionId);
        if (value.candidateFlow && hashBehaviorFlow(value.candidateFlow as Flow) !== value.candidateContentHash
          && hashLegacyBehaviorFlow(record.original.candidateFlow) !== value.candidateContentHash) {
          fail('proposal candidate hash does not match');
        }
        for (const audit of value.auditTrail as RecordValue[]) {
          revision(audit.revisionId);
          ref(c.roleVersions, audit.roleVersionId);
        }
        break;
      }
      case c.behaviorMaintenanceRuns: {
        if (['collecting', 'diagnosing', 'drafting', 'evaluating'].includes(value.state as string)
          || value.diagnosisLeaseId !== undefined) fail('active maintenance must settle before capture');
        const base = revision(value.baseRevisionId, null)!;
        if (base.contentHash !== value.baseContentHash) fail('maintenance baseline hash does not match');
        refs(c.activities, value.sourceActivityIds, true);
        refs(c.behaviorProposals, value.relatedProposalIds, true);
        break;
      }
      case c.behaviorOutcomeMetrics: {
        const proposal = ref(c.behaviorProposals, value.proposalId, true)!;
        if (proposal.behaviorId !== value.behaviorId) fail('outcome metric belongs to another Behavior');
        if (revision(value.baseBehaviorRevisionId)?.contentHash !== value.baseContentHash
          || revision(value.activatedRevisionId)?.contentHash !== value.activatedContentHash) {
          fail('outcome metric hashes do not match its immutable revisions');
        }
        refs(c.activities, value.countedActivityIds, true);
        break;
      }
      case c.mailboxItems:
        ref(c.activities, value.targetActivityId, true);
        ref(c.activities, value.interruptedActivityId, true);
        ref(c.activities, value.claimedActivityId, true);
        ref(c.mailboxItems, value.coalescedIntoId, true);
        break;
      case c.flowDispatches:
        ref(c.activities, value.activityId, true);
        ref(c.activities, value.targetActivityId, true);
        ref(c.mailboxItems, value.mailboxItemId, true);
        revision(value.behaviorRevisionId);
        context(value.instructionContext, value.activityId);
        if (value.state === 'running') fail('running dispatch must settle or pause before capture');
        break;
      case c.leases:
      case c.leaseHistory:
        ref(c.activities, value.activityId, true);
        if (value.status === 'active') fail('active execution lease must be released before capture');
        break;
      case c.runtimeRecoveryReceipts: {
        const result = value.result as RecordValue;
        if (result.personaId !== owner) fail('recovery receipt crosses Persona ownership');
        refs(c.activities, result.closedActivityIds, true);
        refs(c.mailboxItems, result.rejectedMailboxItemIds, true);
        refs(c.mailboxItems, result.requeuedMailboxItemIds, true);
        if (value.phase !== 'committed') fail('runtime recovery must settle before capture');
        break;
      }
      case c.deletionTombstones:
        if (value.status !== 'completed') fail('Persona deletion must finish before capture');
        if (typeof value.retainedPersonaId === 'string' && (
          value.id !== personaDeletionTombstoneId(sourceWorkspace, value.retainedPersonaId)
          || value.personaIdHash !== createHash('sha256').update(`${sourceWorkspace}\0${value.retainedPersonaId}`).digest('hex')
        )) fail('retained deletion identity does not match');
        break;
      case c.appGrants:
        break; // Owner was checked above; connections are external and grants remain evidence-only.
    }
  }

  // Iterative traversal handles long task chains without overflowing the JS stack.
  const work = tables.get(c.workItems)!;
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const id of work.keys()) {
    const stack: Array<{ id: string; leaving: boolean }> = [{ id, leaving: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.leaving) { visiting.delete(frame.id); visited.add(frame.id); continue; }
      if (visited.has(frame.id)) continue;
      if (visiting.has(frame.id)) throw new PersonaRecoveryGraphError(c.workItems, frame.id, 'cyclic Task/goal dependencies');
      visiting.add(frame.id);
      stack.push({ ...frame, leaving: true });
      const item = work.get(frame.id)!;
      const dependencies = [...item.dependencyIds as string[], ...(item.parentGoalId ? [item.parentGoalId as string] : [])];
      for (const dependency of dependencies) {
        stack.push({ id: recordKey(c.workItems, dependency, item.personaId as string), leaving: false });
      }
    }
  }
  return { records, flowRefs: [...flowRefs].sort(), conversationRefs: [...conversationRefs].sort() };
}
