import {
  ENDURING_AGENT_SAFE_ID_PATTERN,
  MemoryItemSchema,
  DeletePersonaInputSchema,
  PersonaActivitySchema,
  PersonaLeaseSchema,
  PersonaMailboxItemSchema,
  PersonaDeletionTombstoneSchema,
  PersonaWorkItemSchema,
} from '@/shared/types/enduringAgent';
import {
  randomEnduringAgentId,
  stableEnduringAgentId,
} from '@/backend/services/enduringAgents/ids';

const activity = {
  schemaVersion: 1 as const,
  id: 'activity_1',
  personaId: 'persona_1',
  kind: 'assignment' as const,
  status: 'running' as const,
  source: { kind: 'assignment' as const, sourceId: 'assignment-1' },
  leaseId: 'lease_1',
  createdAt: 100,
  updatedAt: 110,
  startedAt: 105,
};

const lease = {
  schemaVersion: 1 as const,
  id: 'lease_1',
  workspaceId: 'default-workspace',
  personaId: 'persona_1',
  activityId: 'activity_1',
  holderId: 'runtime_1',
  status: 'active' as const,
  fencingToken: 1,
  acquiredAt: 100,
  renewedAt: 110,
  expiresAt: 200,
};

const mailboxItem = {
  schemaVersion: 1 as const,
  id: 'mailbox_1',
  personaId: 'persona_1',
  idempotencyKey: 'a'.repeat(64),
  sequence: 1,
  kind: 'assignment' as const,
  priority: 'normal' as const,
  status: 'queued' as const,
  source: { kind: 'assignment' as const, sourceId: 'assignment-1' },
  createdAt: 100,
  updatedAt: 100,
};

const workItem = {
  schemaVersion: 1 as const,
  id: 'work_1',
  personaId: 'persona_1',
  title: 'Finish the implementation',
  status: 'open' as const,
  priority: 'normal' as const,
  dependencyIds: [],
  createdAt: 100,
  updatedAt: 100,
};

const memory = {
  schemaVersion: 1 as const,
  id: 'memory_1',
  personaId: 'persona_1',
  kind: 'semantic' as const,
  scope: 'persona' as const,
  status: 'active' as const,
  content: 'The user explicitly prefers concise progress updates.',
  confidence: 1,
  importance: 0.8,
  sourceRefs: [{ kind: 'user_statement' as const, id: 'message-1' }],
  trust: 'explicit_user' as const,
  createdAt: 100,
  updatedAt: 100,
};

describe('enduring-agent lifecycle schemas', () => {
  it('accepts coherent Activity lifecycle timestamps', () => {
    expect(PersonaActivitySchema.safeParse(activity).success).toBe(true);
    expect(PersonaActivitySchema.safeParse({
      ...activity,
      status: 'completed',
      completedAt: 110,
    }).success).toBe(true);
  });

  it.each([
    ['running without startedAt', { ...activity, startedAt: undefined }],
    ['queued after starting', { ...activity, status: 'queued' as const }],
    ['terminal without completedAt', { ...activity, status: 'cancelled' as const }],
    ['completion before start', {
      ...activity,
      status: 'completed' as const,
      completedAt: 104,
    }],
    ['error without an error message', {
      ...activity,
      status: 'error' as const,
      completedAt: 110,
    }],
  ])('rejects an Activity that is %s', (_label, record) => {
    expect(PersonaActivitySchema.safeParse(record).success).toBe(false);
  });

  it('ties lease release state to release time', () => {
    expect(PersonaLeaseSchema.safeParse(lease).success).toBe(true);
    expect(PersonaLeaseSchema.safeParse({
      ...lease,
      status: 'released',
      releasedAt: 120,
    }).success).toBe(true);
    expect(PersonaLeaseSchema.safeParse({
      ...lease,
      status: 'released',
    }).success).toBe(false);
    expect(PersonaLeaseSchema.safeParse({
      ...lease,
      releasedAt: 120,
    }).success).toBe(false);
    expect(PersonaLeaseSchema.safeParse({
      ...lease,
      renewedAt: 90,
    }).success).toBe(false);
  });

  it('requires terminal mailbox metadata to match status', () => {
    expect(PersonaMailboxItemSchema.safeParse(mailboxItem).success).toBe(true);
    expect(PersonaMailboxItemSchema.safeParse({
      ...mailboxItem,
      status: 'completed',
      claimedActivityId: 'activity_1',
      completedAt: 110,
      updatedAt: 110,
    }).success).toBe(true);
    expect(PersonaMailboxItemSchema.safeParse({
      ...mailboxItem,
      status: 'completed',
      completedAt: 110,
      updatedAt: 110,
    }).success).toBe(false);
    expect(PersonaMailboxItemSchema.safeParse({
      ...mailboxItem,
      status: 'coalesced',
      completedAt: 110,
      updatedAt: 110,
    }).success).toBe(false);
    expect(PersonaMailboxItemSchema.safeParse({
      ...mailboxItem,
      status: 'coalesced',
      coalescedIntoId: mailboxItem.id,
      completedAt: 110,
      updatedAt: 110,
    }).success).toBe(false);
  });

  it('ties WorkItem completion state to completedAt', () => {
    expect(PersonaWorkItemSchema.safeParse(workItem).success).toBe(true);
    expect(PersonaWorkItemSchema.safeParse({
      ...workItem,
      status: 'completed',
      completedAt: 110,
      updatedAt: 110,
    }).success).toBe(true);
    expect(PersonaWorkItemSchema.safeParse({
      ...workItem,
      status: 'completed',
    }).success).toBe(false);
    expect(PersonaWorkItemSchema.safeParse({
      ...workItem,
      completedAt: 100,
    }).success).toBe(false);
  });

  it('rejects contradictory MemoryItem provenance timelines and supersession', () => {
    expect(MemoryItemSchema.safeParse(memory).success).toBe(true);
    expect(MemoryItemSchema.safeParse({
      ...memory,
      supersedes: [memory.id],
    }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({
      ...memory,
      validFrom: 200,
      validUntil: 199,
    }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({
      ...memory,
      updatedAt: 99,
    }).success).toBe(false);
  });

  it('requires explicit deletion confirmation and policy-consistent tombstones', () => {
    const input = {
      previewToken: 'b'.repeat(64),
      archivePolicy: 'anonymize',
      confirmation: 'DELETE',
    };
    expect(DeletePersonaInputSchema.safeParse(input).success).toBe(true);
    expect(DeletePersonaInputSchema.safeParse({ ...input, confirmation: 'delete' }).success)
      .toBe(false);

    const tombstone = {
      schemaVersion: 1,
      id: 'deletion_1',
      workspaceId: 'workspace-1',
      personaIdHash: 'c'.repeat(64),
      status: 'completed',
      archivePolicy: 'anonymize',
      previewToken: 'd'.repeat(64),
      counts: {
        behaviorBindings: 0,
        behaviorRevisions: 0,
        memoryItems: 0,
        workItems: 0,
        liveActivities: 0,
        archivedActivities: 0,
        openMailboxItems: 0,
        archivedMailboxItems: 0,
        leaseRecords: 0,
        coreMemoryItems: 0,
        homeFiles: 0,
        homeBytes: 0,
      },
      requestedAt: 100,
      updatedAt: 110,
      completedAt: 110,
    };
    expect(PersonaDeletionTombstoneSchema.safeParse(tombstone).success).toBe(true);
    expect(PersonaDeletionTombstoneSchema.safeParse({
      ...tombstone,
      retainedPersonaId: 'persona_1',
    }).success).toBe(false);
    expect(PersonaDeletionTombstoneSchema.safeParse({
      ...tombstone,
      archivePolicy: 'retain_tombstone',
    }).success).toBe(false);
  });
});

describe('enduring-agent generated ids', () => {
  it.each([
    ['stable', (prefix: string) => stableEnduringAgentId(prefix, { value: 1 })],
    ['random', randomEnduringAgentId],
  ])('generates a schema-safe, bounded %s id', (_label, generate) => {
    const id = generate('prefix_123456789');

    expect(id).toMatch(ENDURING_AGENT_SAFE_ID_PATTERN);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it.each(['', '_persona', 'persona id', 'persona/id', 'x'.repeat(17)])(
    'rejects invalid prefixes consistently: %p',
    (prefix) => {
      expect(() => stableEnduringAgentId(prefix, 'value')).toThrow(/invalid enduring-agent id prefix/i);
      expect(() => randomEnduringAgentId(prefix)).toThrow(/invalid enduring-agent id prefix/i);
    },
  );
});
