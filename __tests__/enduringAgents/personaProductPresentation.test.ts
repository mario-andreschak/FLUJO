import { projectPersonaPresentation } from '@/backend/services/enduringAgents/personaPresentation';

function workItem(id: string, priority: 'low' | 'normal' | 'high' | 'urgent', updatedAt: number) {
  return {
    schemaVersion: 1,
    id,
    personaId: 'persona_queue',
    title: id,
    status: 'open' as const,
    priority,
    dependencyIds: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function mailbox(
  id: string,
  sourceId: string,
  priority: 'low' | 'normal' | 'high' | 'urgent',
  sequence: number,
) {
  return {
    schemaVersion: 1,
    id,
    personaId: 'persona_queue',
    idempotencyKey: id,
    sequence,
    kind: 'assignment' as const,
    priority,
    status: 'queued' as const,
    source: { kind: 'assignment' as const, sourceId },
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('Persona product Task ordering', () => {
  it.each(['goal', 'child'])('shows partial %s work as goal progress in history and conversations', (sourceId) => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [
        { ...workItem('goal', 'normal', 10), goal: { state: 'active' } },
        { ...workItem('child', 'normal', 10), parentGoalId: 'goal', status: 'completed' },
      ],
      mailboxItems: [],
      activities: [{
        id: 'progress', personaId: 'persona_queue', kind: 'assignment', status: 'completed',
        source: { kind: 'assignment', sourceId }, conversationId: 'progress-conversation',
        createdAt: 20, completedAt: 30,
        outcome: { resolution: 'partial', summary: 'Verified a sourced guide.', nextAction: 'Research the next audience.', goalAchieved: false },
      }],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];
    const presentation = projectPersonaPresentation(bundle);
    expect(presentation.history[0].outcome).toBe('progress');
    expect(presentation.conversations[0].outcome).toBe('progress');
    // A later owner Stop must not rewrite a past round as failed or completed.
    bundle.workItems[0].goal!.state = 'stopped';
    expect(projectPersonaPresentation(bundle).history[0].outcome).toBe('progress');
  });

  it.each([
    ['partial', undefined, false, 'completed'],
    ['blocked', 'transient', true, 'completed'],
    ['failed', undefined, true, 'completed'],
    ['unknown', undefined, true, 'completed'],
    ['partial', 'approval', true, 'completed'],
    ['partial', 'transient', true, 'completed'],
    ['partial', undefined, true, 'error'],
  ])('preserves attention for %s / %s with goal=%s and status=%s', (resolution, blockerKind, linkedGoal, status) => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [{ ...workItem('task', 'normal', 10), ...(linkedGoal ? { goal: { state: 'active' } } : {}) }],
      mailboxItems: [],
      activities: [{
        id: 'attention', personaId: 'persona_queue', kind: 'assignment', status,
        source: { kind: 'assignment', sourceId: 'task' }, conversationId: 'attention-conversation',
        createdAt: 20, completedAt: 30, outcome: { resolution, blockerKind },
      }],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];
    const presentation = projectPersonaPresentation(bundle);
    expect(presentation.history[0].outcome).toBe('needs_attention');
    expect(presentation.conversations[0].outcome).toBe('needs_attention');
  });

  it.each(['missing', 'another-persona'])('does not infer goal progress through a %s parent', (parent) => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [
        { ...workItem('child', 'normal', 10), parentGoalId: 'goal' },
        ...(parent === 'missing' ? [] : [{ ...workItem('goal', 'normal', 10), personaId: 'other', goal: { state: 'active' } }]),
      ],
      mailboxItems: [],
      activities: [{
        id: 'orphan', personaId: 'persona_queue', kind: 'assignment', status: 'completed',
        source: { kind: 'assignment', sourceId: 'child' }, createdAt: 20,
        outcome: { resolution: 'partial' },
      }],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];
    expect(projectPersonaPresentation(bundle).history[0].outcome).toBe('needs_attention');
  });

  it('marks only generated labels for translation, including when an owner title matches a default', () => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [{ ...workItem('owned', 'normal', 20), title: 'Assigned task' }],
      mailboxItems: [],
      activities: [
        { id: 'chat', kind: 'interactive_chat', source: { kind: 'chat' } },
        { id: 'missing', kind: 'assignment', source: { kind: 'assignment', sourceId: 'removed' } },
        { id: 'owned', kind: 'assignment', source: { kind: 'assignment', sourceId: 'owned' } },
      ].map((activity) => ({
        ...activity, schemaVersion: 1, personaId: 'persona_queue', status: 'completed', createdAt: 20, updatedAt: 30,
      })),
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];
    const { history } = projectPersonaPresentation(bundle);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: 'Conversation', summaryKind: 'interactive_chat' }),
      expect.objectContaining({ summary: 'Assigned task', summaryKind: 'assignment' }),
    ]));
    expect(history.filter((entry) => entry.summaryKind === undefined)).toEqual([
      expect.objectContaining({ summary: 'Assigned task' }),
    ]);
  });

  it.each([true, false])('keeps the current open goal out of the waiting queue without hiding its queued child (direct source: %s)', (directSource) => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [workItem('goal', 'normal', 20), { ...workItem('child', 'urgent', 30), parentGoalId: 'goal' }],
      mailboxItems: [
        { ...mailbox('mail_goal', 'goal', 'normal', 1), status: 'claimed', claimedActivityId: 'activity_goal' },
        { ...mailbox('mail_child', 'child', 'urgent', 2), targetActivityId: 'activity_goal' },
      ],
      activities: [{
        schemaVersion: 1, id: 'activity_goal', personaId: 'persona_queue', kind: 'assignment', status: 'running',
        source: { kind: 'assignment', ...(directSource ? { sourceId: 'goal' } : {}) }, createdAt: 20, updatedAt: 30,
      }],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];

    const presentation = projectPersonaPresentation(bundle, { activeActivityId: 'activity_goal' });
    expect(presentation.tasks.find((task) => task.id === 'goal')?.state).toBe('in_progress');
    expect(presentation.tasks.filter((task) => task.state === 'waiting').map((task) => task.id)).toEqual(['child']);
  });

  it('shows queued Tasks in the same priority/sequence order the runtime will use', () => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [
        workItem('normal_later', 'normal', 40),
        workItem('urgent', 'urgent', 20),
        workItem('normal_first', 'normal', 30),
      ],
      mailboxItems: [
        mailbox('mail_normal_later', 'normal_later', 'normal', 5),
        mailbox('mail_urgent', 'urgent', 'urgent', 9),
        mailbox('mail_normal_first', 'normal_first', 'normal', 2),
      ],
      activities: [],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];

    expect(projectPersonaPresentation(bundle).tasks.map((task) => task.id)).toEqual([
      'urgent',
      'normal_first',
      'normal_later',
    ]);
  });

  it('shows the latest finished Task first with its safe result and record link', () => {
    const bundle = {
      persona: { id: 'persona_queue' },
      workItems: [
        {
          ...workItem('older', 'urgent', 30),
          status: 'completed' as const,
          completedAt: 30,
        },
        {
          ...workItem('newer', 'normal', 50),
          status: 'completed' as const,
          completedAt: 50,
        },
      ],
      mailboxItems: [],
      activities: [{
        schemaVersion: 1,
        id: 'activity_newer',
        personaId: 'persona_queue',
        kind: 'assignment' as const,
        status: 'completed' as const,
        source: { kind: 'assignment' as const, sourceId: 'newer' },
        conversationId: 'conversation_result',
        createdAt: 40,
        updatedAt: 50,
        completedAt: 50,
      }],
    } as unknown as Parameters<typeof projectPersonaPresentation>[0];

    const presentation = projectPersonaPresentation(bundle, {
      resultByActivityId: new Map([['activity_newer', 'The requested report is ready.']]),
    });

    expect(presentation.tasks.map((task) => task.id)).toEqual(['newer', 'older']);
    expect(presentation.tasks[0]).toMatchObject({
      resultSummary: 'The requested report is ready.',
      recordLinks: [{ kind: 'conversation', id: 'conversation_result' }],
    });
    expect(presentation.history[0]).toMatchObject({
      summary: 'newer',
      resultSummary: 'The requested report is ready.',
      recordLinks: [{ kind: 'conversation', id: 'conversation_result' }],
    });
  });
});
