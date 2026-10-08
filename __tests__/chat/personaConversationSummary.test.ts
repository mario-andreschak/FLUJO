import { summarizeConversation } from '@/backend/execution/flow/conversationSummaryStore';

const baseState = {
  conversationId: 'conversation-1',
  title: 'Persona chat',
  flowId: '',
  messages: [],
  trackingInfo: { executionId: 'execution-1', startTime: 1, nodeExecutionTracker: [] },
  createdAt: 1,
  updatedAt: 2,
};

describe('Persona conversation summary attribution', () => {
  it('projects the complete trusted attribution triple', () => {
    expect(summarizeConversation({
      ...baseState,
      personaBehaviorSlotKey: 'research',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    } as any, 'fallback')).toMatchObject({
      personaOwned: true,
      personaId: 'persona-1',
      personaBehaviorSlotKey: 'research',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    });
  });

  it('keeps a draft target visibly Persona-owned without fabricating attribution', () => {
    const summary = summarizeConversation({
      ...baseState,
      personaTargetId: 'persona-1',
      personaBehaviorSlotKey: 'research',
    } as any, 'fallback');
    expect(summary).toMatchObject({
      personaOwned: true,
      personaId: 'persona-1',
      personaBehaviorSlotKey: 'research',
    });
    expect(summary).not.toHaveProperty('activityId');
    expect(summary).not.toHaveProperty('behaviorRevisionId');
  });

  it('keeps an anonymized archive private without exposing attribution ids', () => {
    const summary = summarizeConversation({
      ...baseState,
      personaArchived: true,
      personaBehaviorSlotKey: 'research',
    } as any, 'fallback');
    expect(summary).toMatchObject({ personaOwned: true, personaArchived: true });
    expect(summary).not.toHaveProperty('personaId');
    expect(summary).not.toHaveProperty('personaBehaviorSlotKey');
    expect(summary).not.toHaveProperty('activityId');
    expect(summary).not.toHaveProperty('behaviorRevisionId');
  });

  it.each([
    ['frozen instruction context', { personaInstructionContext: { personaId: 'persona-1' } }],
    ['corrupt null attribution', { personaAttribution: null }],
    ['corrupt empty target', { personaTargetId: '' }],
    ['legacy ownership marker', { personaOwned: true }],
  ])('fails closed when summarizing %s', (_label, markers) => {
    expect(summarizeConversation({
      ...baseState,
      ...markers,
    } as any, 'fallback')).toMatchObject({ personaOwned: true });
  });

  it('does not classify false legacy/archive flags as Persona-owned', () => {
    expect(summarizeConversation({
      ...baseState,
      personaOwned: false,
      personaArchived: false,
    } as any, 'fallback')).not.toHaveProperty('personaOwned');
  });
});
