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
