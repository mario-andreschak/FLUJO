import { SchedulerService } from '@/backend/services/scheduler';
import { getFlowRunEventBus } from '@/backend/services/scheduler/flowRunEventBus';
import {
  _setRunHistoryExecutionIdsForTests,
  updateRunRecord,
} from '@/backend/services/scheduler/runHistory';
import { createHash } from 'crypto';
import type {
  PlannedExecution,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';

const storage = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    storage.has(key) ? JSON.parse(JSON.stringify(storage.get(key))) : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    storage.set(key, JSON.parse(JSON.stringify(value)));
  }),
  clearItem: jest.fn(async (key: string) => {
    storage.delete(key);
  }),
}));

const mockWithPersonaRuntimeLock = jest.fn(async (
  _id: string,
  task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
) => task({ assertOwned: async () => undefined }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: (
    id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => mockWithPersonaRuntimeLock(id, task),
}));

let encryptionLocked = false;
jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => encryptionLocked),
}));

const mockRunFlow = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => mockRunFlow(...args),
}));

const mockLoadConversationState = jest.fn();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => mockLoadConversationState(...args),
}));

jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: jest.fn(async () => ({ name: 'Scheduler test Flow' })),
  },
}));

const mockGetPersona = jest.fn();
const mockGetPersonaDeletionTombstone = jest.fn();
const mockListBehaviorBindings = jest.fn();
const mockGetBehaviorRevision = jest.fn();
jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersona: (...args: unknown[]) => mockGetPersona(...args),
  getPersonaDeletionTombstone: (...args: unknown[]) =>
    mockGetPersonaDeletionTombstone(...args),
  listBehaviorBindings: (...args: unknown[]) => mockListBehaviorBindings(...args),
  getBehaviorRevision: (...args: unknown[]) => mockGetBehaviorRevision(...args),
}));

const mockSubmitPersonaFlowDispatch = jest.fn();
const mockGetPersonaFlowDispatch = jest.fn();
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  submitPersonaFlowDispatch: (...args: unknown[]) => mockSubmitPersonaFlowDispatch(...args),
  getPersonaFlowDispatch: (...args: unknown[]) => mockGetPersonaFlowDispatch(...args),
}));

const PERSONA_ID = 'persona_scheduler';
const BEHAVIOR_ID = 'behavior_primary';
const REVISION_ID = 'revision_primary_v1';

function scheduleInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'execution_persona',
    name: 'Persona digest',
    enabled: true,
    flowId: 'legacy_flow_provenance',
    prompt: 'Summarize the event',
    trigger: { type: 'schedule' as const, cron: '0 9 * * *' },
    ...overrides,
  };
}

function completedDispatch(input: Record<string, any>, suffix = 'default') {
  return {
    schemaVersion: 1,
    id: `dispatch_${suffix}`,
    workspaceId: 'default',
    personaId: input.personaId,
    idempotencyDigest: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    state: 'completed',
    admission: {
      kind: input.kind,
      priority: input.priority ?? 'normal',
      source: input.source,
      behaviorSlotKey: input.behaviorSlotKey ?? 'primary',
      relationKey: input.relationKey,
      summary: input.summary,
    },
    flowInput: input.flowInput,
    mailboxItemId: `mailbox_${suffix}`,
    routingDecision: 'queued',
    activityId: `activity_${suffix}`,
    behaviorRevisionId: `revision_pinned_${suffix}`,
    outcome: {
      status: 'completed',
      conversationId: input.flowInput.conversationId,
      runId: input.flowInput.runId,
      outputText: `completed ${suffix}`,
      personaId: input.personaId,
      activityId: `activity_${suffix}`,
      behaviorRevisionId: `revision_pinned_${suffix}`,
    },
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    completedAt: 2,
  };
}

function readRuns(id: string): RunRecord[] {
  return (storage.get(`planned-execution-runs/${id}`) as RunRecord[]) ?? [];
}

describe('SchedulerService Persona dispatch adapter', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    storage.clear();
    _setRunHistoryExecutionIdsForTests([]);
    jest.clearAllMocks();
    encryptionLocked = false;
    mockLoadConversationState.mockReset().mockResolvedValue(undefined);
    mockRunFlow.mockResolvedValue({
      status: 'completed',
      outputText: 'legacy completed',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, byNode: {} },
      messages: [],
      conversationId: 'legacy_conversation',
      sharedState: {},
    });
    mockGetPersona.mockResolvedValue({
      id: PERSONA_ID,
      provisioningState: 'ready',
      lifecycleState: 'idle',
    });
    mockGetPersonaDeletionTombstone.mockResolvedValue(null);
    mockListBehaviorBindings.mockResolvedValue([{
      id: BEHAVIOR_ID,
      personaId: PERSONA_ID,
      slotKey: 'primary',
      activeRevisionId: REVISION_ID,
    }]);
    mockGetBehaviorRevision.mockResolvedValue({
      id: REVISION_ID,
      personaId: PERSONA_ID,
      behaviorId: BEHAVIOR_ID,
      slotKey: 'primary',
    });
    mockWithPersonaRuntimeLock.mockReset().mockImplementation(async (
      _id: string,
      task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
    ) => task({ assertOwned: async () => undefined }));
    mockSubmitPersonaFlowDispatch.mockImplementation(async (input: Record<string, any>) => ({
      dispatch: completedDispatch(input, String(mockSubmitPersonaFlowDispatch.mock.calls.length)),
      decision: 'queued',
    }));
    mockGetPersonaFlowDispatch.mockResolvedValue(null);
    scheduler = new SchedulerService();
  });

  afterAll(() => {
    _setRunHistoryExecutionIdsForTests(undefined);
  });

  it('validates Persona readiness, safe target ids, and the selected Behavior slot', async () => {
    const valid = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    expect(valid.error).toBeUndefined();
    expect(valid.execution).toMatchObject({ personaId: PERSONA_ID });
    expect(valid.execution?.behaviorSlotKey).toBeUndefined();

    const slotWithoutPersona = await scheduler.create(scheduleInput({
      id: 'slot_without_persona',
      behaviorSlotKey: 'primary',
    }));
    expect(slotWithoutPersona.error).toMatch(/requires a Persona/i);

    const unsafeExecutionId = await scheduler.create(scheduleInput({
      id: 'package.execution',
      personaId: PERSONA_ID,
    }));
    expect(unsafeExecutionId.error).toMatch(/Persona-targeted execution id/i);

    const legacyPackage = await scheduler.create(scheduleInput({
      id: 'legacy.package',
      personaId: undefined,
    }));
    expect(legacyPackage.error).toBeUndefined();
    expect(legacyPackage.execution).not.toHaveProperty('personaId');
    const unsafeTargetUpdate = await scheduler.update('legacy.package', {
      personaId: PERSONA_ID,
    });
    expect(unsafeTargetUpdate.error).toMatch(/Persona-targeted execution id/i);
    expect((await scheduler.get('legacy.package'))?.personaId).toBeUndefined();

    mockGetPersona.mockResolvedValueOnce(null);
    const missing = await scheduler.create(scheduleInput({
      id: 'missing_persona',
      personaId: 'persona_missing',
    }));
    expect(missing.error).toMatch(/was not found/i);

    mockGetPersona.mockResolvedValueOnce({
      id: PERSONA_ID,
      provisioningState: 'pending',
      lifecycleState: 'idle',
    });
    const pending = await scheduler.create(scheduleInput({
      id: 'pending_persona',
      personaId: PERSONA_ID,
    }));
    expect(pending.error).toMatch(/not ready/i);

    mockListBehaviorBindings.mockResolvedValueOnce([]);
    const missingSlot = await scheduler.create(scheduleInput({
      id: 'missing_slot',
      personaId: PERSONA_ID,
      behaviorSlotKey: 'primary',
    }));
    expect(missingSlot.error).toMatch(/no active Behavior/i);

    const clearable = await scheduler.create(scheduleInput({
      id: 'clear_persona_target',
      personaId: PERSONA_ID,
    }));
    expect(clearable.error).toBeUndefined();
    const cleared = await scheduler.update('clear_persona_target', {
      personaId: undefined,
      behaviorSlotKey: undefined,
    });
    expect(cleared.error).toBeUndefined();
    expect(cleared.execution).not.toHaveProperty('personaId');
    expect(cleared.execution).not.toHaveProperty('behaviorSlotKey');
    expect(await scheduler.get('clear_persona_target')).not.toHaveProperty('personaId');
  });

  it('revalidates Persona deletion after waiting for the config mutation lock', async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockWithPersonaRuntimeLock.mockImplementation(async (
      id: string,
      task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
    ) => {
      if (id === 'scheduler_planned_executions') {
        entered();
        await gate;
      }
      return task({ assertOwned: async () => undefined });
    });
    mockGetPersonaDeletionTombstone
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ status: 'completed' });

    const creation = scheduler.create(scheduleInput({
      id: 'execution_create_delete_race',
      personaId: PERSONA_ID,
    }));
    await enteredLock;
    release();

    await expect(creation).resolves.toEqual({
      error: `Persona "${PERSONA_ID}" is not ready to accept work`,
    });
    expect(await scheduler.get('execution_create_delete_race')).toBeNull();
  });

  it.each([
    ['empty Persona id', { personaId: '' }],
    ['orphaned Behavior slot', { behaviorSlotKey: 'primary' }],
    ['invalid Behavior slot', { personaId: PERSONA_ID, behaviorSlotKey: 'bad slot' }],
    ['invalid retirement marker', { personaRetired: false }],
    ['invalid archive marker', { personaArchived: false }],
  ])('fails closed for persisted %s instead of using Flow authority', async (_label, markers) => {
    const execution = {
      ...scheduleInput({ id: 'execution_corrupt_persona' }),
      generationId: 'generation_corrupt_persona',
      createdAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:00:00.000Z',
      ...markers,
    } as unknown as PlannedExecution;
    storage.set('planned_executions', {
      version: 1,
      paused: false,
      executions: [execution],
    });

    await scheduler.start();
    const [listed] = await scheduler.list();
    expect(listed.status).toMatchObject({
      armed: false,
      lastTriggerError: 'Persona planned execution ownership metadata is incomplete',
    });

    await expect(scheduler.runNow(execution.id)).resolves.toMatchObject({
      record: {
        status: 'skipped',
        error: 'Persona planned execution ownership metadata is incomplete',
      },
    });

    // A callback armed from an older legacy snapshot must also honor the
    // currently persisted Persona marker before it can invoke runFlow.
    const staleLegacy = { ...execution } as Record<string, unknown>;
    delete staleLegacy.personaId;
    delete staleLegacy.behaviorSlotKey;
    delete staleLegacy.personaRetired;
    delete staleLegacy.personaArchived;
    await expect(scheduler.fire(
      staleLegacy as unknown as PlannedExecution,
      { kind: 'schedule', summary: 'Stale legacy callback' },
      'run_stale_corrupt_persona',
    )).resolves.toMatchObject({
      status: 'skipped',
      error: 'Persona planned execution ownership metadata is incomplete',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it('fences a stale direct-Flow callback after its target changes to a Persona', async () => {
    const capturedFlow = (await scheduler.create(scheduleInput({
      id: 'execution_flow_to_persona',
      personaId: undefined,
    }))).execution!;
    await expect(scheduler.update(capturedFlow.id, {
      personaId: PERSONA_ID,
    })).resolves.toMatchObject({
      execution: { personaId: PERSONA_ID },
    });

    await expect(scheduler.fire(
      capturedFlow,
      { kind: 'schedule', summary: 'Stale direct-Flow callback' },
      'run_flow_to_persona_race',
    )).resolves.toMatchObject({
      status: 'skipped',
      error: 'Persona planned execution authority changed before firing',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it('fences a stale Persona callback after its target is removed', async () => {
    const capturedPersona = (await scheduler.create(scheduleInput({
      id: 'execution_persona_to_flow',
      personaId: PERSONA_ID,
    }))).execution!;
    const cleared = await scheduler.update(capturedPersona.id, {
      personaId: undefined,
      behaviorSlotKey: undefined,
    });
    expect(cleared.execution).not.toHaveProperty('personaId');

    await expect(scheduler.fire(
      capturedPersona,
      { kind: 'schedule', summary: 'Stale Persona callback' },
      'run_persona_to_flow_race',
    )).resolves.toMatchObject({
      status: 'skipped',
      error: 'Persona planned execution authority changed before firing',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it('fences a stale Persona callback after its execution is deleted', async () => {
    const capturedPersona = (await scheduler.create(scheduleInput({
      id: 'execution_persona_deleted',
      personaId: PERSONA_ID,
    }))).execution!;
    await expect(scheduler.delete(capturedPersona.id)).resolves.toEqual({ success: true });

    await expect(scheduler.fire(
      capturedPersona,
      { kind: 'schedule', summary: 'Deleted Persona callback' },
      'run_persona_deleted_race',
    )).resolves.toMatchObject({
      status: 'skipped',
      error: 'Persona planned execution authority changed before firing',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['Persona id', { personaId: 'persona_other' }],
    ['effective Behavior slot', { behaviorSlotKey: 'secondary' }],
    ['execution generation', { generationId: 'generation_recreated' }],
  ])('fences a stale Persona callback when the current %s differs', async (_label, patch) => {
    const capturedPersona = (await scheduler.create(scheduleInput({
      id: 'execution_persona_authority_mismatch',
      personaId: PERSONA_ID,
    }))).execution!;
    const config = storage.get('planned_executions') as {
      version: 1;
      paused: boolean;
      executions: PlannedExecution[];
    };
    config.executions[0] = { ...config.executions[0], ...patch };
    storage.set('planned_executions', structuredClone(config));

    await expect(scheduler.fire(
      capturedPersona,
      { kind: 'schedule', summary: 'Mismatched Persona authority' },
      'run_persona_authority_mismatch',
    )).resolves.toMatchObject({
      status: 'skipped',
      error: 'Persona planned execution authority changed before firing',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['retired', { personaRetired: true }],
    ['archived', { personaArchived: true }],
  ])('never arms or runs an orphaned %s Persona marker', async (_label, markers) => {
    const execution = {
      ...scheduleInput({ id: 'execution_orphaned_persona_tombstone' }),
      generationId: 'generation_orphaned_persona_tombstone',
      createdAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:00:00.000Z',
      ...markers,
    } as PlannedExecution;
    storage.set('planned_executions', {
      version: 1,
      paused: false,
      executions: [execution],
    });

    await scheduler.start();
    const [listed] = await scheduler.list();
    expect(listed.status.armed).toBe(false);
    await expect(scheduler.runNow(execution.id)).resolves.toEqual({
      error: 'A retired Persona planned execution cannot be run',
    });
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it('retires exact Persona runtime before anonymizing only matching attribution', async () => {
    const execution = (await scheduler.create(scheduleInput({
      personaId: PERSONA_ID,
      behaviorSlotKey: 'primary',
      enabled: false,
    }))).execution!;
    const otherExecution = {
      ...execution,
      id: 'execution_unrelated_archive',
      generationId: 'generation_unrelated_archive',
      name: 'Unrelated Persona schedule',
      personaId: 'persona_unrelated_archive',
      enabled: false,
    };
    const config = storage.get('planned_executions') as {
      version: 1;
      paused: boolean;
      executions: Array<typeof execution>;
    };
    config.executions.push(otherExecution);
    storage.set('planned_executions', structuredClone(config));

    const targetRun: RunRecord = {
      runId: 'run_archive_target',
      conversationId: 'conversation_archive_target',
      firedAt: '2026-08-10T10:00:00.000Z',
      finishedAt: '2026-08-10T10:00:01.000Z',
      status: 'completed',
      triggerSummary: 'Schedule',
      outputText: 'Retain target output.',
      personaId: PERSONA_ID,
      activityId: 'activity_archive_target',
      behaviorRevisionId: 'revision_archive_target',
    };
    const otherRun: RunRecord = {
      ...targetRun,
      runId: 'run_archive_other',
      conversationId: 'conversation_archive_other',
      outputText: 'Retain unrelated output.',
      personaId: otherExecution.personaId,
      activityId: 'activity_archive_other',
      behaviorRevisionId: 'revision_archive_other',
    };
    storage.set(`planned-execution-runs/${execution.id}`, [targetRun, otherRun]);
    _setRunHistoryExecutionIdsForTests([execution.id]);

    const targetReceipt = {
      id: 'receipt_archive_target',
      executionId: execution.id,
      runId: targetRun.runId,
      event: {
        flowId: execution.flowId,
        executionId: execution.id,
        runId: targetRun.runId,
        conversationId: targetRun.conversationId,
        status: 'completed',
        firedBy: 'schedule',
        chainDepth: 0,
        timestamp: targetRun.finishedAt,
        deliveryId: 'receipt_archive_target',
      },
      record: targetRun,
      createdAt: targetRun.finishedAt,
    };
    const otherReceipt = {
      ...targetReceipt,
      id: 'receipt_archive_other',
      runId: otherRun.runId,
      event: {
        ...targetReceipt.event,
        runId: otherRun.runId,
        conversationId: otherRun.conversationId,
        deliveryId: 'receipt_archive_other',
      },
      record: otherRun,
    };
    storage.set('scheduler-terminal-publication-outbox', {
      version: 1,
      pending: {
        [targetReceipt.id]: targetReceipt,
        [otherReceipt.id]: otherReceipt,
      },
    });
    storage.set('pending_approvals', {
      approval_target: {
        approvalId: 'approval_target',
        terminalPublication: { execution: { personaId: PERSONA_ID } },
      },
      approval_other: {
        approvalId: 'approval_other',
        terminalPublication: { execution: { personaId: otherExecution.personaId } },
      },
    });
    storage.set('scheduler-persona-projections', {
      version: 1,
      pending: {
        projection_target: {
          id: 'projection_target',
          execution: {
            id: execution.id,
            generationId: execution.generationId,
            personaId: PERSONA_ID,
          },
        },
        projection_other: {
          id: 'projection_other',
          execution: {
            id: otherExecution.id,
            generationId: otherExecution.generationId,
            personaId: otherExecution.personaId,
          },
        },
      },
      deletedExecutions: {},
      deletedProjections: {},
    });
    storage.set('scheduler-file-watch-intents', {
      version: 1,
      pending: {
        intent_target: { id: 'intent_target', execution: { personaId: PERSONA_ID } },
        intent_other: { id: 'intent_other', execution: { personaId: otherExecution.personaId } },
      },
    });

    await expect(scheduler.retirePersonaByPersonaId(PERSONA_ID))
      .resolves.toEqual({
        plannedExecutions: 1,
        pendingApprovals: 1,
        pendingProjections: 1,
        pendingFileWatchIntents: 1,
      });

    const retiredConfig = await scheduler.get(execution.id);
    expect(retiredConfig).toEqual(expect.objectContaining({
      id: execution.id,
      enabled: false,
      personaId: PERSONA_ID,
      personaRetired: true,
    }));
    expect(retiredConfig).not.toHaveProperty('personaArchived');
    await expect(scheduler.runNow(execution.id)).resolves.toEqual({
      error: 'A retired Persona planned execution cannot be run',
    });
    await expect(scheduler.update(execution.id, { enabled: true })).resolves.toEqual({
      error: 'A retired Persona planned execution is read-only',
    });
    await expect(scheduler.fire(
      execution,
      { kind: 'schedule', summary: 'Stale armed callback' },
      'run_after_retirement',
    )).resolves.toMatchObject({
      runId: 'run_after_retirement',
      status: 'skipped',
      error: 'A retired Persona planned execution cannot be fired',
    });
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(readRuns(execution.id)).toEqual([targetRun, otherRun]);
    expect(storage.get('scheduler-terminal-publication-outbox')).toEqual({
      version: 1,
      pending: {
        [targetReceipt.id]: targetReceipt,
        [otherReceipt.id]: otherReceipt,
      },
    });
    expect(storage.get('pending_approvals')).toEqual({
      approval_other: expect.any(Object),
    });
    expect(storage.get('scheduler-persona-projections')).toMatchObject({
      pending: { projection_other: expect.any(Object) },
      deletedProjections: { projection_target: expect.any(String) },
    });
    expect(storage.get('scheduler-file-watch-intents')).toEqual({
      version: 1,
      pending: { intent_other: expect.any(Object) },
    });
    await expect(scheduler.retirePersonaByPersonaId(PERSONA_ID)).resolves.toEqual({
      plannedExecutions: 0,
      pendingApprovals: 0,
      pendingProjections: 0,
      pendingFileWatchIntents: 0,
    });

    await expect(scheduler.anonymizePersonaAttributionByPersonaId(PERSONA_ID))
      .resolves.toEqual({
        plannedExecutions: 1,
        runHistories: 1,
        runRecords: 1,
        terminalReceipts: 1,
        pendingApprovals: 0,
        pendingProjections: 0,
        pendingFileWatchIntents: 0,
      });

    const archivedConfig = await scheduler.get(execution.id);
    expect(archivedConfig).toEqual(expect.objectContaining({
      id: execution.id,
      name: execution.name,
      prompt: execution.prompt,
      flowId: execution.flowId,
      behaviorSlotKey: execution.behaviorSlotKey,
      trigger: execution.trigger,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      enabled: false,
      personaRetired: true,
      personaArchived: true,
    }));
    expect(archivedConfig).not.toHaveProperty('personaId');
    await expect(scheduler.runNow(execution.id)).resolves.toEqual({
      error: 'A retired Persona planned execution cannot be run',
    });
    await expect(scheduler.update(execution.id, { enabled: true })).resolves.toEqual({
      error: 'A retired Persona planned execution is read-only',
    });
    await expect(scheduler.get(otherExecution.id)).resolves.toEqual(otherExecution);

    expect(readRuns(execution.id)).toEqual([
      expect.objectContaining({
        runId: targetRun.runId,
        outputText: targetRun.outputText,
        personaArchived: true,
      }),
      otherRun,
    ]);
    expect(readRuns(execution.id)[0]).not.toHaveProperty('personaId');
    expect(readRuns(execution.id)[0]).not.toHaveProperty('activityId');
    expect(readRuns(execution.id)[0]).not.toHaveProperty('behaviorRevisionId');
    expect(storage.get('scheduler-terminal-publication-outbox')).toMatchObject({
      pending: {
        receipt_archive_target: {
          record: { runId: targetRun.runId, personaArchived: true },
        },
        receipt_archive_other: otherReceipt,
      },
    });
    expect(storage.get('pending_approvals')).toEqual({
      approval_other: expect.any(Object),
    });
    expect(storage.get('scheduler-persona-projections')).toMatchObject({
      pending: { projection_other: expect.any(Object) },
      deletedProjections: { projection_target: expect.any(String) },
    });
    expect(storage.get('scheduler-file-watch-intents')).toEqual({
      version: 1,
      pending: { intent_other: expect.any(Object) },
    });

    const archivedSnapshots = {
      config: structuredClone(storage.get('planned_executions')),
      runs: structuredClone(storage.get(`planned-execution-runs/${execution.id}`)),
      outbox: structuredClone(storage.get('scheduler-terminal-publication-outbox')),
      approvals: structuredClone(storage.get('pending_approvals')),
      projections: structuredClone(storage.get('scheduler-persona-projections')),
      intents: structuredClone(storage.get('scheduler-file-watch-intents')),
    };
    await expect(scheduler.anonymizePersonaAttributionByPersonaId(PERSONA_ID))
      .resolves.toEqual({
        plannedExecutions: 0,
        runHistories: 0,
        runRecords: 0,
        terminalReceipts: 0,
        pendingApprovals: 0,
        pendingProjections: 0,
        pendingFileWatchIntents: 0,
      });
    expect({
      config: storage.get('planned_executions'),
      runs: storage.get(`planned-execution-runs/${execution.id}`),
      outbox: storage.get('scheduler-terminal-publication-outbox'),
      approvals: storage.get('pending_approvals'),
      projections: storage.get('scheduler-persona-projections'),
      intents: storage.get('scheduler-file-watch-intents'),
    }).toEqual(archivedSnapshots);
  });

  it.each([
    'manual',
    'schedule',
    'schedule-catchup',
    'webhook',
    'file',
    'mcp-poll',
    'url-watch',
    'flow-event',
  ] as const)('routes %s fires through the Persona mailbox', async (kind) => {
    const { execution } = await scheduler.create(scheduleInput({
      personaId: PERSONA_ID,
      behaviorSlotKey: 'primary',
    }));
    const payload: TriggerFirePayload = { kind, summary: `Source ${kind}` };
    const record = await scheduler.fire(execution!, payload, `run_${kind.replaceAll('-', '_')}`);

    expect(record.status).toBe('completed');
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledTimes(1);
    const dispatchInput = mockSubmitPersonaFlowDispatch.mock.calls[0][0];
    const scheduled = kind === 'manual' || kind === 'schedule' || kind === 'schedule-catchup';
    expect(dispatchInput).toMatchObject({
      personaId: PERSONA_ID,
      kind: scheduled ? 'scheduled' : 'triggered',
      source: {
        kind: scheduled ? 'schedule' : 'trigger',
        sourceId: `${execution!.id}:${execution!.generationId}`,
      },
      behaviorSlotKey: 'primary',
      relationKey: `planned-execution:${execution!.id}:${execution!.generationId}`,
    });
    expect(dispatchInput.flowInput).not.toHaveProperty('flowId');
    expect(dispatchInput.flowInput).toMatchObject({
      plannedExecutionId: execution!.id,
      source: 'schedule',
      userTurn: true,
    });
  });

  it('leaves the persona-less direct runFlow contract unchanged', async () => {
    const { execution } = await scheduler.create(scheduleInput({
      id: 'legacy_execution',
      personaId: undefined,
    }));
    const record = await scheduler.fire(execution!, {
      kind: 'webhook',
      summary: 'Legacy webhook',
      context: { event: 'push' },
      deliveryId: 'ignored_for_legacy_compatibility',
    }, 'legacy_run');

    expect(record.status).toBe('completed');
    expect(mockSubmitPersonaFlowDispatch).not.toHaveBeenCalled();
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
    expect(mockRunFlow.mock.calls[0][0]).toMatchObject({
      flowId: 'legacy_flow_provenance',
      runId: 'legacy_run',
      source: 'schedule',
      plannedExecutionId: 'legacy_execution',
      userTurn: true,
    });
    expect(mockRunFlow.mock.calls[0][0].prompt).toContain('"now"');
  });

  it('serializes stable Persona Flow input for retries of one trusted delivery', async () => {
    const { execution } = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    const payload: TriggerFirePayload = {
      kind: 'webhook',
      summary: 'Webhook',
      context: { body: { event: 'push' }, contentType: 'application/json' },
      deliveryId: `webhook-${'d'.repeat(64)}`,
    };
    let stableDispatch: ReturnType<typeof completedDispatch> | undefined;
    let submissionCount = 0;
    mockSubmitPersonaFlowDispatch.mockImplementation(async (input: Record<string, any>) => {
      stableDispatch ??= completedDispatch(input, 'stable_retry');
      return {
        dispatch: stableDispatch,
        decision: submissionCount++ === 0 ? 'queued' : 'duplicate',
      };
    });
    const terminalEvents: Array<{ executionId: string; runId: string }> = [];
    const unsubscribe = getFlowRunEventBus().subscribe((event) => {
      if ('executionId' in event && event.executionId) {
        terminalEvents.push({ executionId: event.executionId, runId: event.runId });
      }
    });
    let first: RunRecord;
    let second: RunRecord;
    try {
      first = await scheduler.fire(execution!, payload, 'delivery_run_stable');
      second = await scheduler.fire(execution!, payload, 'delivery_run_stable');
    } finally {
      unsubscribe();
    }

    expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledTimes(2);
    const [firstInput, secondInput] = mockSubmitPersonaFlowDispatch.mock.calls.map((call) => call[0]);
    expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);
    expect(secondInput.flowInput).toEqual(firstInput.flowInput);
    expect(firstInput.flowInput.conversationId).toMatch(/^conversation-[a-f0-9]{48}$/);
    expect(firstInput.flowInput.prompt).not.toContain('"now"');
    expect(second!).toEqual(first!);
    expect(readRuns(execution!.id)).toEqual([first!]);
    expect(terminalEvents.filter((event) => (
      event.executionId === execution!.id && event.runId === 'delivery_run_stable'
    ))).toHaveLength(1);
  });

  it('fences stable identities by immutable create generation', async () => {
    const first = (await scheduler.create(scheduleInput({ personaId: PERSONA_ID }))).execution!;
    const payload: TriggerFirePayload = {
      kind: 'webhook',
      summary: 'Webhook',
      deliveryId: 'webhook-reused-provider-id',
    };
    const firstRecord = await scheduler.fire(first, payload);
    const firstInput = mockSubmitPersonaFlowDispatch.mock.calls.at(-1)![0];

    await expect(scheduler.delete(first.id)).resolves.toEqual({ success: true });
    const second = (await scheduler.create(scheduleInput({ personaId: PERSONA_ID }))).execution!;
    const secondRecord = await scheduler.fire(second, payload);
    const secondInput = mockSubmitPersonaFlowDispatch.mock.calls.at(-1)![0];

    expect(second.generationId).toBeDefined();
    expect(second.generationId).not.toBe(first.generationId);
    expect(secondRecord.runId).not.toBe(firstRecord.runId);
    expect(secondRecord.conversationId).not.toBe(firstRecord.conversationId);
    expect(secondInput.idempotencyKey).not.toBe(firstInput.idempotencyKey);
    expect(secondInput.source.sourceId).toContain(second.generationId);
    expect(secondInput.relationKey).toContain(second.generationId);
  });

  it('keeps a durable file-watch intent until mailbox admission succeeds', async () => {
    const execution = (await scheduler.create(scheduleInput({ personaId: PERSONA_ID }))).execution!;
    const payload = {
      kind: 'file' as const,
      summary: 'File changed',
      context: { events: [{ event: 'change', path: 'C:/watched/a.txt' }] },
      deliveryId: 'file-stable-batch',
    };
    storage.set('scheduler-file-watch-intents', {
      version: 1,
      pending: {
        'file-intent-file-stable-batch': {
          schemaVersion: 1,
          id: 'file-intent-file-stable-batch',
          execution,
          payload,
          createdAt: '2026-08-09T12:00:00.000Z',
        },
      },
    });
    mockSubmitPersonaFlowDispatch.mockRejectedValueOnce(new Error('mailbox unavailable'));

    await expect(scheduler.reconcileDurableFileWatchIntents(true))
      .rejects.toThrow('mailbox unavailable');
    expect(storage.get('scheduler-file-watch-intents')).toMatchObject({
      pending: { 'file-intent-file-stable-batch': expect.any(Object) },
    });

    let recoveredDispatch: ReturnType<typeof completedDispatch> | undefined;
    mockSubmitPersonaFlowDispatch.mockImplementation(async (input: Record<string, any>) => ({
      dispatch: recoveredDispatch ??= completedDispatch(input, 'file_wal_recovery'),
      decision: recoveredDispatch ? 'duplicate' : 'queued',
    }));
    await scheduler.reconcileDurableFileWatchIntents(true);
    await scheduler.reconcilePersonaSchedulerProjections(true);
    expect(storage.get('scheduler-file-watch-intents')).toMatchObject({ pending: {} });
    expect(readRuns(execution.id)).toEqual([
      expect.objectContaining({ status: 'completed', executionGenerationId: execution.generationId }),
    ]);
  });

  it('does not resurrect history when deletion wins before terminal projection', async () => {
    const execution = (await scheduler.create(scheduleInput({ personaId: PERSONA_ID }))).execution!;
    const submissionInput: Record<string, any> = {
      personaId: PERSONA_ID,
      kind: 'scheduled',
      source: { kind: 'schedule', sourceId: execution.id },
      flowInput: { conversationId: 'conversation_delete_race', runId: 'run_delete_race' },
    };
    const queued = {
      ...completedDispatch(submissionInput, 'delete_race'),
      personaId: PERSONA_ID,
      state: 'queued',
      outcome: undefined,
      completedAt: undefined,
    };
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({ dispatch: queued, decision: 'queued' });
    const admitted = await scheduler.admitPersonaFire(execution, {
      kind: 'schedule',
      summary: 'Schedule',
      deliveryId: 'schedule-delete-race',
    });

    await scheduler.delete(execution.id);
    mockGetPersonaFlowDispatch.mockResolvedValueOnce(completedDispatch(
      mockSubmitPersonaFlowDispatch.mock.calls.at(-1)![0],
      'delete_race',
    ));
    await admitted.completion;

    expect(readRuns(execution.id)).toEqual([]);
    expect(storage.get('scheduler-terminal-publication-outbox')).toBeUndefined();
  });

  it('durably admits while encrypted but defers the dispatcher pump until unlock recovery', async () => {
    const { execution } = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    const payload: TriggerFirePayload = {
      kind: 'schedule',
      summary: 'Locked schedule',
      deliveryId: 'schedule-locked-occurrence',
    };
    const queuedInput = {
      personaId: PERSONA_ID,
      kind: 'scheduled',
      source: { kind: 'schedule', sourceId: execution!.id },
      flowInput: {
        runId: 'delivery_locked',
        conversationId: 'conversation_locked',
      },
    };
    const queued = {
      ...completedDispatch(queuedInput, 'locked'),
      state: 'queued',
      outcome: undefined,
      completedAt: undefined,
    };
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({
      dispatch: queued,
      decision: 'queued',
    });
    encryptionLocked = true;

    const admitted = await scheduler.admitPersonaFire(execution!, payload, 'delivery_locked');
    expect(admitted.dispatchId).toBe(queued.id);
    expect(mockSubmitPersonaFlowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: PERSONA_ID }),
      { startPump: false },
    );
    expect(mockRunFlow).not.toHaveBeenCalled();

    // Simulate the ordinary post-unlock dispatcher startup reconciling and
    // completing the already-durable queued envelope.
    encryptionLocked = false;
    mockGetPersonaFlowDispatch.mockResolvedValueOnce(completedDispatch(
      mockSubmitPersonaFlowDispatch.mock.calls[0][0],
      'locked',
    ));
    await expect(admitted.completion).resolves.toMatchObject({
      status: 'completed',
      runId: 'delivery_locked',
      personaId: PERSONA_ID,
    });
  });

  it('startup projects a dispatch that completed after the admitting process crashed', async () => {
    const { execution } = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    const runId = 'delivery_projection_recovery';
    const conversationId = 'conversation_projection_recovery';
    const deliveryId = 'schedule-projection-recovery';
    const submission = {
      personaId: PERSONA_ID,
      idempotencyKey: `planned:${execution!.id}:${deliveryId}`,
      kind: 'scheduled' as const,
      source: { kind: 'schedule' as const, sourceId: execution!.id },
      relationKey: `planned-execution:${execution!.id}`,
      summary: `${execution!.name}: Schedule`,
      flowInput: {
        prompt: 'Pinned projection prompt',
        mode: 'ephemeral' as const,
        conversationId,
        runId,
        source: 'schedule' as const,
        plannedExecutionId: execution!.id,
        plannedExecutionName: execution!.name,
        chainDepth: 0,
        requireApproval: false,
        onApprovalRequired: 'auto' as const,
        debug: false,
        userTurn: true,
      },
    };
    const projectionId = `projection-${createHash('sha256')
      .update(`${execution!.id}\0${runId}`)
      .digest('hex')
      .slice(0, 48)}`;
    storage.set('scheduler-persona-projections', {
      version: 1,
      pending: {
        [projectionId]: {
          schemaVersion: 1,
          id: projectionId,
          execution: {
            id: execution!.id,
            name: execution!.name,
            flowId: execution!.flowId,
            personaId: PERSONA_ID,
          },
          payload: { kind: 'schedule', summary: 'Schedule', deliveryId },
          submission,
          runId,
          conversationId,
          firedAt: '2026-08-09T12:00:00.000Z',
          dispatchId: 'dispatch_projection_recovery',
          createdAt: '2026-08-09T12:00:00.000Z',
          updatedAt: '2026-08-09T12:00:01.000Z',
        },
      },
    });
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({
      dispatch: completedDispatch(submission, 'projection_recovery'),
      decision: 'duplicate',
    });
    const terminalEvents: Array<{ runId: string; deliveryId?: string }> = [];
    const unsubscribe = getFlowRunEventBus().subscribe((event) => {
      if (!('status' in event)) return;
      terminalEvents.push({ runId: event.runId, deliveryId: event.deliveryId });
    });
    try {
      await scheduler.reconcilePersonaSchedulerProjections(true);
    } finally {
      unsubscribe();
    }

    expect(readRuns(execution!.id)).toEqual([
      expect.objectContaining({ runId, status: 'completed', personaId: PERSONA_ID }),
    ]);
    expect(terminalEvents).toEqual([
      expect.objectContaining({ runId, deliveryId: expect.stringMatching(/^terminal-/) }),
    ]);
    expect(storage.get('scheduler-persona-projections')).toMatchObject({
      version: 1,
      pending: {},
    });
  });

  it('does not poison a stable delivery when dispatcher admission fails before ownership', async () => {
    const { execution } = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    const payload: TriggerFirePayload = {
      kind: 'url-watch',
      summary: 'Changed content',
      deliveryId: 'url-watch-content-attempt-0',
    };
    mockSubmitPersonaFlowDispatch.mockRejectedValueOnce(new Error('mailbox disk unavailable'));
    const first = await scheduler.fire(execution!, payload, 'delivery_admission_retry');
    expect(first.status).toBe('skipped');
    expect(readRuns(execution!.id)).toEqual([]);

    mockSubmitPersonaFlowDispatch.mockImplementationOnce(async (input: Record<string, any>) => ({
      dispatch: completedDispatch(input, 'admission_retry'),
      decision: 'queued',
    }));
    await scheduler.reconcilePersonaSchedulerProjections(true);
    expect(readRuns(execution!.id)).toEqual([
      expect.objectContaining({ status: 'completed', runId: 'delivery_admission_retry' }),
    ]);
  });

  it('polls through transient waits and maps approval and terminal errors truthfully', async () => {
    const { execution } = await scheduler.create(scheduleInput({ personaId: PERSONA_ID }));
    const baseInput = {
      personaId: PERSONA_ID,
      kind: 'triggered',
      source: { kind: 'trigger', sourceId: execution!.id },
      flowInput: { runId: 'run_transient', conversationId: 'conversation_transient' },
    };
    const transient = {
      ...completedDispatch(baseInput, 'transient'),
      state: 'waiting',
      waitingReason: 'delivery',
      outcome: undefined,
      completedAt: undefined,
    };
    const interrupted = { ...transient, waitingReason: 'interrupted', updatedAt: 3 };
    const completed = completedDispatch(baseInput, 'transient');
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({ dispatch: transient, decision: 'steered' });
    mockGetPersonaFlowDispatch
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(completed);

    const transientRecord = await scheduler.fire(
      execution!,
      { kind: 'webhook', summary: 'Transient delivery' },
      'run_transient',
    );
    expect(mockGetPersonaFlowDispatch).toHaveBeenCalledTimes(2);
    expect(transientRecord).toMatchObject({
      status: 'completed',
      personaId: PERSONA_ID,
      activityId: 'activity_transient',
      behaviorRevisionId: 'revision_pinned_transient',
    });

    const approvalInput = {
      ...baseInput,
      flowInput: { runId: 'run_approval', conversationId: 'conversation_approval' },
    };
    const approval = {
      ...completedDispatch(approvalInput, 'approval'),
      state: 'waiting',
      waitingReason: 'approval',
      completedAt: undefined,
      outcome: {
        ...completedDispatch(approvalInput, 'approval').outcome,
        status: 'awaiting_tool_approval',
      },
    };
    mockLoadConversationState.mockResolvedValueOnce({
      status: 'awaiting_tool_approval',
      pendingToolCalls: [{
        id: 'call_persona_approval',
        type: 'function',
        function: { name: 'send_email', arguments: '{"secret":"not-in-inbox"}' },
      }],
    });
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({ dispatch: approval, decision: 'queued' });
    const approvalRecord = await scheduler.fire(
      execution!,
      { kind: 'schedule', summary: 'Approval' },
      'run_approval',
    );
    expect(approvalRecord).toMatchObject({
      status: 'needs_approval',
      error: 'Awaiting tool approval',
      behaviorRevisionId: 'revision_pinned_approval',
      pendingApproval: {
        tool: 'send_email',
        toolCallId: 'call_persona_approval',
        pendingToolCalls: [{ id: 'call_persona_approval', name: 'send_email' }],
      },
    });
    expect(storage.get('pending_approvals')).toMatchObject({
      [approvalRecord.conversationId]: {
        approvalId: approvalRecord.conversationId,
        plannedExecutionId: execution!.id,
        runId: 'run_approval',
        pendingToolCalls: [{ id: 'call_persona_approval', name: 'send_email' }],
      },
    });
    expect(JSON.stringify(storage.get('pending_approvals'))).not.toContain('not-in-inbox');

    // The approval route patches this row rather than replacing it. Verify the
    // real history implementation keeps immutable Persona/revision attribution.
    await updateRunRecord(execution!.id, 'run_approval', {
      status: 'completed',
      finishedAt: '2026-08-09T12:00:00.000Z',
      outputText: 'Approved and completed',
      error: undefined,
      pendingApproval: undefined,
    });
    expect(readRuns(execution!.id).find((record) => record.runId === 'run_approval'))
      .toMatchObject({
        status: 'completed',
        personaId: PERSONA_ID,
        activityId: 'activity_approval',
        behaviorRevisionId: 'revision_pinned_approval',
        outputText: 'Approved and completed',
      });

    const errored = {
      ...completedDispatch(baseInput, 'error'),
      state: 'error',
      outcome: undefined,
      error: { code: 'FLOW_RESULT_ERROR', message: 'Pinned Behavior failed', at: 4 },
    };
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({ dispatch: errored, decision: 'queued' });
    const errorRecord = await scheduler.fire(
      execution!,
      { kind: 'file', summary: 'Error' },
      'run_error',
    );
    expect(errorRecord).toMatchObject({
      status: 'error',
      error: 'Pinned Behavior failed',
      personaId: PERSONA_ID,
      behaviorRevisionId: 'revision_pinned_error',
    });
    expect(readRuns(execution!.id).map((record) => record.status))
      .toEqual(['completed', 'completed', 'error']);
  });

  it('publishes approved Persona completion from pinned metadata after a Persona-to-legacy edit', async () => {
    const execution = (await scheduler.create(scheduleInput({
      personaId: PERSONA_ID,
      behaviorSlotKey: 'primary',
    }))).execution!;
    const approvalInput = {
      personaId: PERSONA_ID,
      kind: 'scheduled',
      source: { kind: 'schedule', sourceId: `${execution.id}:${execution.generationId}` },
      flowInput: { runId: 'run_pinned_approval', conversationId: 'conversation_pinned_approval' },
    };
    const approvalDispatch = {
      ...completedDispatch(approvalInput, 'pinned_approval'),
      state: 'waiting',
      waitingReason: 'approval',
      completedAt: undefined,
      outcome: {
        ...completedDispatch(approvalInput, 'pinned_approval').outcome,
        status: 'awaiting_tool_approval',
      },
    };
    mockLoadConversationState.mockResolvedValueOnce({
      status: 'awaiting_tool_approval',
      pendingToolCalls: [{
        id: 'call_pinned_approval',
        type: 'function',
        function: { name: 'send_email', arguments: '{}' },
      }],
    });
    mockSubmitPersonaFlowDispatch.mockResolvedValueOnce({
      dispatch: approvalDispatch,
      decision: 'queued',
    });
    const record = await scheduler.fire(execution, {
      kind: 'schedule',
      summary: 'Approval',
      deliveryId: 'schedule-pinned-approval',
    }, 'run_pinned_approval');
    const pending = (storage.get('pending_approvals') as Record<string, any>)[record.conversationId];

    await scheduler.update(execution.id, {
      personaId: undefined,
      behaviorSlotKey: undefined,
    });
    const events: string[] = [];
    const unsubscribe = getFlowRunEventBus().subscribe((event) => {
      if ('status' in event) events.push(event.runId);
    });
    try {
      await scheduler.completeApprovedPersonaRun({
        executionId: execution.id,
        runId: record.runId,
        status: 'completed',
        finishedAt: '2026-08-09T13:00:00.000Z',
        outputText: 'Approved',
        conversationId: record.conversationId,
        firedAt: record.firedAt,
        triggerSummary: record.triggerSummary,
        personaAttribution: {
          personaId: PERSONA_ID,
          activityId: record.activityId!,
          behaviorRevisionId: record.behaviorRevisionId!,
        },
        terminalPublication: pending.terminalPublication,
      });
    } finally {
      unsubscribe();
    }

    expect(readRuns(execution.id)).toEqual([
      expect.objectContaining({
        runId: record.runId,
        status: 'completed',
        executionGenerationId: execution.generationId,
        personaId: PERSONA_ID,
      }),
    ]);
    expect(events).toContain(record.runId);
  });
});
