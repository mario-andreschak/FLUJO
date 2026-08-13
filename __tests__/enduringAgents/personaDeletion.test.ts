import { promises as fs } from 'fs';
import path from 'path';

import {
  PersonaDeletionConflictError,
  appendPersonaRuntimeEvent,
  assertPersonaActivityLease,
  claimNextPersonaActivity,
  deletePersona,
  enqueuePersonaMailboxItem,
  previewPersonaDeletion,
  readPersonaRuntimeEvents,
} from '@/backend/services/enduringAgents';
import { createPersonaFromRole } from './fixtures/personaFactory';
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
import {
  loadCollectionItem,
  loadItem,
  saveCollectionItem,
  saveItem,
} from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { ticketService } from '@/backend/services/ticket';
import type { Ticket } from '@/shared/types/ticket';
import type { SharedState } from '@/backend/execution/flow/types';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { listConversationSummaries } from '@/backend/execution/flow/conversationSummaryStore';
import {
  appendStatisticsEvent,
  createStatisticsEvent,
  readStatisticsEvents,
} from '@/backend/services/statistics';
import {
  createMeetingRecord,
  getMeeting,
  saveMeeting,
} from '@/backend/services/meetings/store';
import {
  appendMeetingEvent,
  readMeetingEvents,
} from '@/backend/services/meetings/eventLog';
import { ARCHIVED_MEETING_PARTICIPANT_NAME } from '@/shared/types/meeting';
import { MeetingEngine } from '@/backend/execution/meeting/MeetingEngine';
import type {
  PlannedExecution,
  PlannedExecutionsFile,
  RunRecord,
} from '@/shared/types/plannedExecution';
import { getSchedulerService } from '@/backend/services/scheduler';
import { loadRunRecords } from '@/backend/services/scheduler/runHistory';

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

function plannedExecution(
  id: string,
  personaId: string,
  enabled: boolean,
): PlannedExecution {
  return {
    id,
    generationId: `generation_${id}`,
    name: `Authored ${id}`,
    enabled,
    flowId: `flow_${id}`,
    personaId,
    behaviorSlotKey: 'primary',
    prompt: `Preserve prompt for ${id}.`,
    trigger: { type: 'webhook', token: `token_${id}`, allowExternal: false },
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:30:00.000Z',
  };
}

function schedulerRun(runId: string, personaId: string): RunRecord {
  return {
    runId,
    executionGenerationId: `generation_${runId}`,
    conversationId: `conversation_${runId}`,
    firedAt: '2026-08-10T10:00:00.000Z',
    finishedAt: '2026-08-10T10:00:01.000Z',
    status: 'completed',
    triggerSummary: 'Webhook',
    outputText: `Preserve output for ${runId}.`,
    personaId,
    activityId: `activity_${runId}`,
    behaviorRevisionId: `revision_${runId}`,
  };
}

async function seedMeetingAndSchedulerAttribution(personaId: string, suffix: string) {
  const meetingDraft = createMeetingRecord({
    id: `meeting_${suffix}`,
    title: `Authored meeting ${suffix}`,
    openingPrompt: `Preserve opening prompt ${suffix}.`,
    participants: [
      {
        id: `participant_${suffix}`,
        name: `Private Persona ${suffix}`,
        personaId,
        behaviorSlotKey: 'primary',
        conversationId: `meeting_conversation_${suffix}`,
      },
      {
        id: `other_participant_${suffix}`,
        name: 'Unrelated participant',
        flowId: `flow_other_${suffix}`,
        conversationId: `other_conversation_${suffix}`,
      },
    ],
  });
  meetingDraft.status = 'completed';
  meetingDraft.phase = 'completed';
  meetingDraft.completedAt = 40;
  meetingDraft.participants[0].activityId = `activity_meeting_${suffix}`;
  meetingDraft.participants[0].behaviorRevisionId = `revision_meeting_${suffix}`;
  const meeting = await saveMeeting(meetingDraft);
  const participantEvent = (await appendMeetingEvent(meeting.id, {
    type: 'participant:spoke',
    audience: 'public',
    participantId: meeting.participants[0].id,
    participantName: meeting.participants[0].name,
    turnId: `turn_${suffix}`,
    content: `Preserve authored contribution ${suffix}.`,
    eventId: `event_target_${suffix}`,
  })).event;
  const otherEvent = (await appendMeetingEvent(meeting.id, {
    type: 'participant:spoke',
    audience: 'public',
    participantId: meeting.participants[1].id,
    participantName: meeting.participants[1].name,
    turnId: `turn_other_${suffix}`,
    content: 'Preserve unrelated contribution.',
    eventId: `event_other_${suffix}`,
  })).event;

  const activeMeetingDraft = createMeetingRecord({
    id: `meeting_active_${suffix}`,
    title: `Active meeting ${suffix}`,
    openingPrompt: `Preserve active prompt ${suffix}.`,
    participants: [
      {
        id: `active_participant_${suffix}`,
        name: `Active Private Persona ${suffix}`,
        personaId,
        behaviorSlotKey: 'primary',
        conversationId: `active_meeting_conversation_${suffix}`,
      },
      {
        id: `active_other_participant_${suffix}`,
        name: 'Active unrelated participant',
        flowId: `active_flow_other_${suffix}`,
        conversationId: `active_other_conversation_${suffix}`,
      },
    ],
  });
  activeMeetingDraft.status = 'running';
  activeMeetingDraft.phase = 'discussion';
  activeMeetingDraft.participants[0].activityId = `activity_active_meeting_${suffix}`;
  activeMeetingDraft.participants[0].behaviorRevisionId = `revision_active_meeting_${suffix}`;
  activeMeetingDraft.personaReservationGeneration = 4;
  activeMeetingDraft.personaReservationIntent = {
    generation: 4,
    attemptId: `active_attempt_${suffix}`,
    ownerId: `active_owner_${suffix}`,
    state: 'running',
    createdAt: 10,
    updatedAt: 20,
    expiresAt: 30_020,
  };
  const activeMeeting = await saveMeeting(activeMeetingDraft);

  const targetExecution = plannedExecution(`execution_${suffix}`, personaId, true);
  const otherExecution = plannedExecution(`other_execution_${suffix}`, 'persona_unrelated', false);
  const configFile: PlannedExecutionsFile = {
    version: 1,
    paused: false,
    executions: [targetExecution, otherExecution],
  };
  await saveItem(StorageKey.PLANNED_EXECUTIONS, configFile);

  const targetRun = schedulerRun(`run_${suffix}`, personaId);
  const otherRun = schedulerRun(`other_run_${suffix}`, 'persona_unrelated');
  const historyId = `orphan_history_${suffix}`;
  const runRecords = [targetRun, otherRun];
  await saveItem(`planned-execution-runs/${historyId}` as StorageKey, runRecords);

  const flowEvent = {
    flowId: targetExecution.flowId,
    executionId: historyId,
    runId: targetRun.runId,
    conversationId: targetRun.conversationId,
    status: 'completed' as const,
    firedBy: 'webhook' as const,
    chainDepth: 0,
    timestamp: targetRun.finishedAt!,
    deliveryId: `terminal_${suffix}`,
  };
  const terminalOutbox = {
    version: 1,
    pending: {
      [`receipt_${suffix}`]: {
        id: `receipt_${suffix}`,
        executionId: historyId,
        runId: targetRun.runId,
        event: flowEvent,
        record: targetRun,
        createdAt: targetRun.finishedAt!,
      },
      [`other_receipt_${suffix}`]: {
        id: `other_receipt_${suffix}`,
        executionId: historyId,
        runId: otherRun.runId,
        event: { ...flowEvent, runId: otherRun.runId, conversationId: otherRun.conversationId },
        record: otherRun,
        createdAt: otherRun.finishedAt!,
      },
    },
  };
  await saveItem('scheduler-terminal-publication-outbox' as StorageKey, terminalOutbox);

  const pendingApprovals = {
    [`approval_${suffix}`]: {
      approvalId: `approval_${suffix}`,
      conversationId: targetRun.conversationId,
      plannedExecutionId: targetExecution.id,
      flowId: targetExecution.flowId,
      runId: targetRun.runId,
      triggerSummary: targetRun.triggerSummary,
      pendingToolCalls: [],
      createdAt: targetRun.firedAt,
      terminalPublication: {
        triggerKind: 'webhook',
        chainDepth: 0,
        deliveryId: `delivery_${suffix}`,
        execution: {
          id: targetExecution.id,
          generationId: targetExecution.generationId,
          name: targetExecution.name,
          flowId: targetExecution.flowId,
          personaId,
        },
      },
    },
    [`other_approval_${suffix}`]: {
      approvalId: `other_approval_${suffix}`,
      conversationId: otherRun.conversationId,
      plannedExecutionId: otherExecution.id,
      flowId: otherExecution.flowId,
      runId: otherRun.runId,
      triggerSummary: otherRun.triggerSummary,
      pendingToolCalls: [],
      createdAt: otherRun.firedAt,
      terminalPublication: {
        triggerKind: 'webhook',
        chainDepth: 0,
        deliveryId: `other_delivery_${suffix}`,
        execution: {
          id: otherExecution.id,
          generationId: otherExecution.generationId,
          name: otherExecution.name,
          flowId: otherExecution.flowId,
          personaId: otherExecution.personaId!,
        },
      },
    },
  };
  await saveItem(StorageKey.PENDING_APPROVALS, pendingApprovals);

  const personaProjections = {
    version: 1,
    pending: {
      [`projection_${suffix}`]: {
        schemaVersion: 1,
        id: `projection_${suffix}`,
        execution: {
          id: targetExecution.id,
          generationId: targetExecution.generationId,
          name: targetExecution.name,
          flowId: targetExecution.flowId,
          personaId,
        },
        payload: { kind: 'webhook', summary: 'Webhook', deliveryId: `delivery_${suffix}` },
        submission: { personaId },
        runId: targetRun.runId,
        conversationId: targetRun.conversationId,
        firedAt: targetRun.firedAt,
        createdAt: targetRun.firedAt,
        updatedAt: targetRun.firedAt,
      },
      [`other_projection_${suffix}`]: {
        schemaVersion: 1,
        id: `other_projection_${suffix}`,
        execution: {
          id: otherExecution.id,
          generationId: otherExecution.generationId,
          name: otherExecution.name,
          flowId: otherExecution.flowId,
          personaId: otherExecution.personaId,
        },
        payload: { kind: 'webhook', summary: 'Webhook', deliveryId: `other_delivery_${suffix}` },
        submission: { personaId: otherExecution.personaId },
        runId: otherRun.runId,
        conversationId: otherRun.conversationId,
        firedAt: otherRun.firedAt,
        createdAt: otherRun.firedAt,
        updatedAt: otherRun.firedAt,
      },
    },
    deletedExecutions: {},
    deletedProjections: {},
  };
  await saveItem('scheduler-persona-projections' as StorageKey, personaProjections);

  const fileWatchIntents = {
    version: 1,
    pending: {
      [`intent_${suffix}`]: {
        schemaVersion: 1,
        id: `intent_${suffix}`,
        execution: targetExecution,
        payload: { kind: 'file', summary: 'File', deliveryId: `file_delivery_${suffix}` },
        createdAt: targetRun.firedAt,
      },
      [`other_intent_${suffix}`]: {
        schemaVersion: 1,
        id: `other_intent_${suffix}`,
        execution: otherExecution,
        payload: { kind: 'file', summary: 'File', deliveryId: `other_file_delivery_${suffix}` },
        createdAt: otherRun.firedAt,
      },
    },
  };
  await saveItem('scheduler-file-watch-intents' as StorageKey, fileWatchIntents);

  return {
    meeting,
    activeMeeting,
    participantEvent,
    otherEvent,
    targetExecution,
    otherExecution,
    configFile,
    historyId,
    runRecords,
    targetRun,
    otherRun,
    terminalOutbox,
    pendingApprovals,
    personaProjections,
    fileWatchIntents,
  };
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
      expect(await readPersonaRuntimeEvents(personaId)).toEqual([]);
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
      await expect(appendPersonaRuntimeEvent(personaId, {
        eventId: 'activity:late',
        type: 'activity:completed',
        activityId: 'activity_late',
      })).rejects.toThrow(/runtime events are closed/i);
      expect(await readPersonaRuntimeEvents(personaId)).toEqual([]);
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

  it('does not admit a Persona meeting after deletion wins the create boundary', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona: target } = await createPersonaFromRole({
        id: 'jim_meeting_create_race',
        name: 'Jim Meeting Race',
      });
      const { persona: peer } = await createPersonaFromRole({
        id: 'sarah_meeting_create_race',
        name: 'Sarah Meeting Race',
      });
      let validated!: () => void;
      let releaseCreate!: () => void;
      const atCreateBoundary = new Promise<void>((resolve) => { validated = resolve; });
      const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const engine = new MeetingEngine({
        isolateProcessRuntime: true,
        failpoints: {
          afterCreateValidationBeforePersist: async () => {
            validated();
            await createGate;
          },
        },
      });
      const meetingId = 'meeting_persona_create_delete_race';
      const creating = engine.create({
        id: meetingId,
        title: 'Deletion admission race',
        openingPrompt: 'This meeting must never be admitted after deletion.',
        participants: [
          { id: 'target', name: target.name, personaId: target.id },
          { id: 'peer', name: peer.name, personaId: peer.id },
        ],
      });

      await atCreateBoundary;
      const preview = await previewPersonaDeletion(target.id);
      await deletePersona(target.id, confirmation(preview.previewToken, 'anonymize'));
      releaseCreate();

      await expect(creating).rejects.toThrow(/pending deletion/i);
      await expect(getMeeting(meetingId)).resolves.toBeNull();
    });
  });

  it('clears ticket attribution for anonymize but preserves it for retain_tombstone', async () => {
    const seedTicket = async (ticket: Ticket) => {
      await saveCollectionItem(StorageKey.TICKETS, ticket.id, ticket);
    };
    const attributedTicket = (id: string, personaId: string): Ticket => ({
      id,
      message: 'Keep the human-visible ticket content.',
      labels: ['audit'],
      status: 'open',
      createdAt: 10,
      updatedAt: 20,
      conversationId: `conversation_${id}`,
      flowId: 'flow_1',
      source: 'agent',
      personaId,
      activityId: `activity_${id}`,
      behaviorRevisionId: `revision_${id}`,
    });

    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_ticket_anonymize', name: 'Jim' });
      const original = attributedTicket('ticket_anonymize', persona.id);
      await seedTicket(original);
      const preview = await previewPersonaDeletion(persona.id);

      const tombstone = await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      );
      await expect(deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      )).resolves.toEqual(tombstone);

      const ticket = await ticketService.getTicket(original.id);
      expect(ticket).toEqual(expect.objectContaining({
        id: original.id,
        message: original.message,
        conversationId: original.conversationId,
        flowId: original.flowId,
        source: original.source,
        createdAt: original.createdAt,
        updatedAt: original.updatedAt,
      }));
      expect(ticket).not.toHaveProperty('personaId');
      expect(ticket).not.toHaveProperty('activityId');
      expect(ticket).not.toHaveProperty('behaviorRevisionId');
    });

    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_ticket_retained', name: 'Jim' });
      const original = attributedTicket('ticket_retained', persona.id);
      await seedTicket(original);
      const preview = await previewPersonaDeletion(persona.id);

      await deletePersona(persona.id, confirmation(preview.previewToken, 'retain_tombstone'));

      await expect(ticketService.getTicket(original.id)).resolves.toEqual(original);
    });
  });

  it('anonymizes retained conversation prompt caches and keeps the archive read-only on retry', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'jim_conversation_anonymize',
        name: 'Jim Private',
      });
      const conversationId = 'conversation_persona_archive';
      const instruction = [
        '# Persona identity',
        'Name: Jim Private',
        'Mission: Keep a private mission out of retained prompt caches.',
        'This context grants no tools or authority.',
      ].join('\n');
      const authoredPrompt = 'Authored Process prompt must remain byte-for-byte.';
      const state = {
        conversationId,
        title: 'Retained transcript',
        flowId: 'behavior-flow',
        flowSnapshot: {
          id: 'behavior-flow',
          name: 'Behavior evidence',
          nodes: [],
          edges: [],
        },
        trackingInfo: { executionId: 'execution-1', startTime: 10, nodeExecutionTracker: [] },
        messages: [
          { id: 'message-1', role: 'user', content: 'Preserve this transcript.', timestamp: 11 },
          { id: 'message-2', role: 'assistant', content: 'Preserved evidence.', timestamp: 12 },
        ],
        status: 'completed',
        titleGenerated: true,
        createdAt: 10,
        updatedAt: 20,
        personaAttribution: {
          personaId: persona.id,
          activityId: 'activity-private',
          behaviorRevisionId: 'revision-private',
        },
        personaInstructionContext: {
          personaId: persona.id,
          activityId: 'activity-private',
          behaviorRevisionId: 'revision-private',
          rootFlowId: 'behavior-flow',
          behaviorSnapshotHash: 'a'.repeat(64),
          personaName: 'Jim Private',
          personaMission: 'Keep a private mission out of retained prompt caches.',
          instruction,
        },
        frozenSystemPrompts: {
          process: `${instruction}\n\n${authoredPrompt}`,
        },
        codexSessions: {
          process: { threadId: 'provider-session-private' },
        },
        executionTrace: [{
          nodeId: 'process',
          stateBefore: {
            personaAttribution: { personaId: persona.id },
            personaInstructionContext: { instruction },
            frozenSystemPrompts: { process: `${instruction}\n\n${authoredPrompt}` },
          },
          modelInput: { systemPrompt: `${instruction}\n\n${authoredPrompt}` },
        }],
      } as unknown as SharedState;
      await saveCollectionItem('conversations', conversationId, state);
      FlowExecutor.conversationStates.set(conversationId, structuredClone(state));

      const preview = await previewPersonaDeletion(persona.id);
      const tombstone = await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      );
      await expect(deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      )).resolves.toEqual(tombstone);

      const archived = await loadCollectionItem<SharedState | undefined>(
        'conversations',
        conversationId,
        undefined,
      );
      expect(archived).toMatchObject({
        personaArchived: true,
        flowId: state.flowId,
        flowSnapshot: state.flowSnapshot,
        messages: state.messages,
        createdAt: 10,
        updatedAt: 20,
        frozenSystemPrompts: { process: authoredPrompt },
      });
      expect(archived).not.toHaveProperty('personaAttribution');
      expect(archived).not.toHaveProperty('personaTargetId');
      expect(archived).not.toHaveProperty('personaInstructionContext');
      expect(archived).not.toHaveProperty('codexSessions');
      expect(JSON.stringify(archived?.executionTrace)).not.toContain(instruction);
      expect(JSON.stringify(archived?.executionTrace)).not.toContain(persona.id);

      const live = FlowExecutor.conversationStates.get(conversationId);
      expect(live).toMatchObject({ personaArchived: true });
      expect(live).not.toHaveProperty('personaAttribution');
      expect(live).not.toHaveProperty('personaInstructionContext');
      expect(live).not.toHaveProperty('codexSessions');

      const summary = (await listConversationSummaries())
        .find((item) => item.id === conversationId);
      expect(summary).toMatchObject({ personaOwned: true, personaArchived: true });
      expect(summary).not.toHaveProperty('personaId');
      expect(summary).not.toHaveProperty('activityId');
      expect(summary).not.toHaveProperty('behaviorRevisionId');
      FlowExecutor.conversationStates.delete(conversationId);
    });
  });

  it('waits for an active conversation writer before scrubbing its snapshot and late statistics', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'jim_conversation_drain',
        name: 'Jim Drain',
      });
      const conversationId = 'conversation_persona_drain';
      const day = '2026-08-10';
      const personaAttribution = {
        personaId: persona.id,
        activityId: 'activity-drain',
        behaviorRevisionId: 'revision-drain',
      };
      const state = {
        conversationId,
        title: 'Before active finalization',
        flowId: 'behavior-flow',
        trackingInfo: { executionId: 'execution-drain', startTime: 10, nodeExecutionTracker: [] },
        messages: [],
        status: 'running',
        createdAt: 10,
        updatedAt: 20,
        personaAttribution,
      } as unknown as SharedState;
      await saveCollectionItem('conversations', conversationId, state);
      FlowExecutor.conversationStates.set(conversationId, structuredClone(state));
      await appendStatisticsEvent(createStatisticsEvent({
        type: 'run.started',
        runId: 'run_conversation_drain',
        timestamp: `${day}T10:00:00.000Z`,
        source: 'api',
        flow: { id: state.flowId },
        personaAttribution,
      }));
      const preview = await previewPersonaDeletion(persona.id);

      let entered!: () => void;
      const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
      const activeFinalization = withConversationExecutionLock(conversationId, async () => {
        entered();
        while (!await getPersonaDeletionTombstone(persona.id)) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        // Give deletion's cross-system phase time to reach the conversation
        // lease. Without the lease/order barriers it can scrub both surfaces
        // before this captured finalization writes them back.
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const lateState = structuredClone(state);
        lateState.title = 'Committed by active finalization';
        lateState.status = 'completed';
        await saveCollectionItem('conversations', conversationId, lateState);
        FlowExecutor.conversationStates.set(conversationId, structuredClone(lateState));
        await appendStatisticsEvent(createStatisticsEvent({
          type: 'run.finished',
          runId: 'run_conversation_drain',
          timestamp: `${day}T10:00:01.000Z`,
          source: 'api',
          flow: { id: state.flowId },
          outcome: 'completed',
          durationMs: 1,
          personaAttribution,
        }));
      });
      await enteredLock;

      const deletion = deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      );
      await Promise.all([activeFinalization, deletion]);

      const archived = await loadCollectionItem<SharedState | undefined>(
        'conversations',
        conversationId,
        undefined,
      );
      expect(archived).toMatchObject({
        title: 'Committed by active finalization',
        status: 'completed',
        personaArchived: true,
      });
      expect(archived).not.toHaveProperty('personaAttribution');
      expect((await readStatisticsEvents(day)).filter(
        (event) => event.runId === 'run_conversation_drain',
      )).toEqual([
        expect.not.objectContaining({ personaAttribution: expect.anything() }),
        expect.not.objectContaining({ personaAttribution: expect.anything() }),
      ]);
      FlowExecutor.conversationStates.delete(conversationId);
    });
  });

  it('anonymizes statistics attribution idempotently but preserves retain-tombstone evidence', async () => {
    const day = '2026-08-10';
    const seedRun = async (runId: string, personaId: string) => {
      const personaAttribution = {
        personaId,
        activityId: `activity_${runId}`,
        behaviorRevisionId: `revision_${runId}`,
      };
      await appendStatisticsEvent(createStatisticsEvent({
        type: 'run.started',
        runId,
        timestamp: `${day}T10:00:00.000Z`,
        source: 'api',
        flow: { id: `flow_${runId}` },
        personaAttribution,
      }));
      await appendStatisticsEvent(createStatisticsEvent({
        type: 'run.finished',
        runId,
        timestamp: `${day}T10:00:01.000Z`,
        source: 'api',
        flow: { id: `flow_${runId}` },
        outcome: 'completed',
        durationMs: 1,
        personaAttribution,
      }));
      return personaAttribution;
    };

    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_stats_anonymize', name: 'Jim' });
      const target = await seedRun('target_anonymize', persona.id);
      const other = await seedRun('unrelated_persona', 'persona_unrelated');
      const preview = await previewPersonaDeletion(persona.id);

      const tombstone = await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      );
      await expect(deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      )).resolves.toEqual(tombstone);

      const events = await readStatisticsEvents(day);
      const targetEvents = events.filter((event) => event.runId === 'target_anonymize');
      expect(targetEvents).toHaveLength(2);
      expect(targetEvents.every((event) => event.personaAttribution === undefined)).toBe(true);
      expect(events.filter((event) => event.runId === 'unrelated_persona'))
        .toEqual(events.filter((event) => event.runId === 'unrelated_persona').map((event) =>
          expect.objectContaining({ personaAttribution: other })));
      expect(JSON.stringify(events)).not.toContain(target.personaId);
    });

    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({ id: 'jim_stats_retained', name: 'Jim' });
      const retained = await seedRun('target_retained', persona.id);
      const preview = await previewPersonaDeletion(persona.id);

      await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'retain_tombstone'),
      );

      expect((await readStatisticsEvents(day)).filter((event) => event.runId === 'target_retained'))
        .toEqual([
          expect.objectContaining({ personaAttribution: retained }),
          expect.objectContaining({ personaAttribution: retained }),
        ]);
    });
  });

  it('applies meeting and scheduler archive policy only for anonymize', async () => {
    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'jim_durable_archive',
        name: 'Jim Durable Private',
      });
      const seeded = await seedMeetingAndSchedulerAttribution(persona.id, 'anonymize');
      const preview = await previewPersonaDeletion(persona.id);
      const tombstone = await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      );

      const meeting = await getMeeting(seeded.meeting.id);
      expect(meeting?.participants[0]).toEqual(expect.objectContaining({
        id: seeded.meeting.participants[0].id,
        name: ARCHIVED_MEETING_PARTICIPANT_NAME,
        personaArchived: true,
        personaRetired: true,
        status: 'left',
      }));
      expect(meeting?.participants[0]).not.toHaveProperty('personaId');
      expect(meeting?.participants[0]).not.toHaveProperty('activityId');
      expect(meeting?.participants[0]).not.toHaveProperty('behaviorRevisionId');
      expect(meeting?.participants[1]).toEqual(seeded.meeting.participants[1]);
      expect(meeting?.updatedAt).toBe(seeded.meeting.updatedAt);
      expect(await readMeetingEvents(seeded.meeting.id)).toEqual([
        { ...seeded.participantEvent, participantName: ARCHIVED_MEETING_PARTICIPANT_NAME },
        seeded.otherEvent,
      ]);
      const archivedActiveMeeting = await getMeeting(seeded.activeMeeting.id);
      expect(archivedActiveMeeting?.participants[0]).toEqual(expect.objectContaining({
        id: seeded.activeMeeting.participants[0].id,
        name: ARCHIVED_MEETING_PARTICIPANT_NAME,
        personaArchived: true,
        personaRetired: true,
        status: 'left',
      }));
      expect(archivedActiveMeeting?.participants[0]).not.toHaveProperty('personaId');
      expect(archivedActiveMeeting?.participants[0]).not.toHaveProperty('activityId');
      expect(archivedActiveMeeting?.participants[0]).not.toHaveProperty('behaviorRevisionId');
      expect(archivedActiveMeeting?.participants[1]).toEqual(seeded.activeMeeting.participants[1]);
      expect(archivedActiveMeeting?.personaReservationGeneration).toBe(5);
      expect(archivedActiveMeeting?.personaReservationIntent).toBeUndefined();
      expect(archivedActiveMeeting?.updatedAt).toBe(seeded.activeMeeting.updatedAt);

      const configs = await loadItem<PlannedExecutionsFile>(
        StorageKey.PLANNED_EXECUTIONS,
        { version: 1, paused: false, executions: [] },
      );
      const archivedExecution = configs.executions.find(
        (execution) => execution.id === seeded.targetExecution.id,
      );
      expect(archivedExecution).toEqual(expect.objectContaining({
        id: seeded.targetExecution.id,
        name: seeded.targetExecution.name,
        flowId: seeded.targetExecution.flowId,
        prompt: seeded.targetExecution.prompt,
        trigger: seeded.targetExecution.trigger,
        behaviorSlotKey: seeded.targetExecution.behaviorSlotKey,
        createdAt: seeded.targetExecution.createdAt,
        updatedAt: seeded.targetExecution.updatedAt,
        enabled: false,
        personaRetired: true,
        personaArchived: true,
      }));
      expect(archivedExecution).not.toHaveProperty('personaId');
      expect(configs.executions.find((execution) => execution.id === seeded.otherExecution.id))
        .toEqual(seeded.otherExecution);

      const runs = await loadRunRecords(seeded.historyId);
      expect(runs).toEqual([
        expect.objectContaining({
          runId: seeded.targetRun.runId,
          outputText: seeded.targetRun.outputText,
          personaArchived: true,
        }),
        seeded.otherRun,
      ]);
      expect(runs[0]).not.toHaveProperty('personaId');
      expect(runs[0]).not.toHaveProperty('activityId');
      expect(runs[0]).not.toHaveProperty('behaviorRevisionId');

      const approvals = await loadItem<Record<string, unknown>>(StorageKey.PENDING_APPROVALS, {});
      expect(approvals).not.toHaveProperty('approval_anonymize');
      expect(approvals).toHaveProperty('other_approval_anonymize');
      const projections = await loadItem<Record<string, any>>(
        'scheduler-persona-projections' as StorageKey,
        {},
      );
      expect(projections.pending).not.toHaveProperty('projection_anonymize');
      expect(projections.pending).toHaveProperty('other_projection_anonymize');
      const intents = await loadItem<Record<string, any>>(
        'scheduler-file-watch-intents' as StorageKey,
        {},
      );
      expect(intents.pending).not.toHaveProperty('intent_anonymize');
      expect(intents.pending).toHaveProperty('other_intent_anonymize');

      const archivedSnapshot = {
        meeting: structuredClone(meeting),
        activeMeeting: structuredClone(archivedActiveMeeting),
        events: structuredClone(await readMeetingEvents(seeded.meeting.id)),
        configs: structuredClone(configs),
        runs: structuredClone(runs),
        approvals: structuredClone(approvals),
        projections: structuredClone(projections),
        intents: structuredClone(intents),
      };
      await expect(deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'anonymize'),
      )).resolves.toEqual(tombstone);
      expect({
        meeting: await getMeeting(seeded.meeting.id),
        activeMeeting: await getMeeting(seeded.activeMeeting.id),
        events: await readMeetingEvents(seeded.meeting.id),
        configs: await loadItem(StorageKey.PLANNED_EXECUTIONS, {}),
        runs: await loadRunRecords(seeded.historyId),
        approvals: await loadItem(StorageKey.PENDING_APPROVALS, {}),
        projections: await loadItem('scheduler-persona-projections' as StorageKey, {}),
        intents: await loadItem('scheduler-file-watch-intents' as StorageKey, {}),
      }).toEqual(archivedSnapshot);
    });

    await runWithWorkspace(freshWorkspace(), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'jim_durable_retained',
        name: 'Jim Retained',
      });
      const seeded = await seedMeetingAndSchedulerAttribution(persona.id, 'retained');
      const preview = await previewPersonaDeletion(persona.id);
      const tombstone = await deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'retain_tombstone'),
      );
      const retainedSnapshot = {
        meeting: await getMeeting(seeded.meeting.id),
        activeMeeting: await getMeeting(seeded.activeMeeting.id),
        events: await readMeetingEvents(seeded.meeting.id),
        configs: await loadItem<PlannedExecutionsFile>(StorageKey.PLANNED_EXECUTIONS, {
          version: 1,
          paused: false,
          executions: [],
        }),
        runs: await loadRunRecords(seeded.historyId),
        outbox: await loadItem('scheduler-terminal-publication-outbox' as StorageKey, {}),
        approvals: await loadItem<Record<string, unknown>>(StorageKey.PENDING_APPROVALS, {}),
        projections: await loadItem<Record<string, any>>(
          'scheduler-persona-projections' as StorageKey,
          {},
        ),
        intents: await loadItem<Record<string, any>>(
          'scheduler-file-watch-intents' as StorageKey,
          {},
        ),
      };
      await expect(deletePersona(
        persona.id,
        confirmation(preview.previewToken, 'retain_tombstone'),
      )).resolves.toEqual(tombstone);

      expect({
        meeting: await getMeeting(seeded.meeting.id),
        activeMeeting: await getMeeting(seeded.activeMeeting.id),
        events: await readMeetingEvents(seeded.meeting.id),
        configs: await loadItem(StorageKey.PLANNED_EXECUTIONS, {}),
        runs: await loadRunRecords(seeded.historyId),
        outbox: await loadItem('scheduler-terminal-publication-outbox' as StorageKey, {}),
        approvals: await loadItem(StorageKey.PENDING_APPROVALS, {}),
        projections: await loadItem('scheduler-persona-projections' as StorageKey, {}),
        intents: await loadItem('scheduler-file-watch-intents' as StorageKey, {}),
      }).toEqual(retainedSnapshot);

      await expect(getMeeting(seeded.meeting.id)).resolves.toEqual(seeded.meeting);
      await expect(readMeetingEvents(seeded.meeting.id)).resolves.toEqual([
        seeded.participantEvent,
        seeded.otherEvent,
      ]);
      expect(retainedSnapshot.activeMeeting?.participants[0]).toEqual({
        ...seeded.activeMeeting.participants[0],
        status: 'left',
        personaRetired: true,
      });
      expect(retainedSnapshot.activeMeeting?.participants[1])
        .toEqual(seeded.activeMeeting.participants[1]);
      expect(retainedSnapshot.activeMeeting?.personaReservationGeneration).toBe(5);
      expect(retainedSnapshot.activeMeeting?.personaReservationIntent).toBeUndefined();
      expect(retainedSnapshot.activeMeeting?.updatedAt).toBe(seeded.activeMeeting.updatedAt);
      expect(retainedSnapshot.configs.executions.find(
        (execution) => execution.id === seeded.targetExecution.id,
      )).toEqual({
        ...seeded.targetExecution,
        enabled: false,
        personaRetired: true,
      });
      expect(retainedSnapshot.configs.executions.find(
        (execution) => execution.id === seeded.otherExecution.id,
      )).toEqual(seeded.otherExecution);
      await expect(loadRunRecords(seeded.historyId)).resolves.toEqual(seeded.runRecords);
      await expect(loadItem('scheduler-terminal-publication-outbox' as StorageKey, {}))
        .resolves.toEqual(seeded.terminalOutbox);
      expect(retainedSnapshot.approvals).not.toHaveProperty('approval_retained');
      expect(retainedSnapshot.approvals).toHaveProperty('other_approval_retained');
      expect(retainedSnapshot.projections.pending).not.toHaveProperty('projection_retained');
      expect(retainedSnapshot.projections.pending).toHaveProperty('other_projection_retained');
      expect(retainedSnapshot.intents.pending).not.toHaveProperty('intent_retained');
      expect(retainedSnapshot.intents.pending).toHaveProperty('other_intent_retained');
    });
  }, 30_000);
});
