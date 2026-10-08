import { getConversationOrigin } from '@/frontend/components/Chat/conversationOrigin';

describe('conversation sidebar origin metadata', () => {
  it.each([
    ['chat', 'User chat'],
    ['api', 'API'],
    ['schedule', 'Automation'],
    ['trigger', 'Trigger'],
    ['subflow', 'Subagent'],
    ['mcp', 'MCP run'],
    ['internal', 'Internal'],
  ] as const)('maps %s runs to %s', (source, label) => {
    expect(getConversationOrigin({ source })).toMatchObject({
      key: source,
      label,
      inferred: false,
    });
  });

  it('infers automation and subflow origins for legacy conversations', () => {
    expect(getConversationOrigin({ plannedExecutionId: 'plan-1' })).toMatchObject({
      key: 'schedule',
      label: 'Automation',
      inferred: true,
    });
    expect(getConversationOrigin({ parentConversationId: 'parent-1' })).toMatchObject({
      key: 'subflow',
      label: 'Subagent',
      inferred: true,
    });
  });

  it('classifies legacy automation descendants as subagents', () => {
    expect(getConversationOrigin({
      plannedExecutionId: 'automation-1',
      parentConversationId: 'automation-root',
    })).toMatchObject({
      key: 'subflow',
      label: 'Subagent',
      inferred: true,
    });
  });

  it('prefers durable source metadata over inferred lineage', () => {
    expect(getConversationOrigin({
      source: 'subflow',
      plannedExecutionId: 'plan-1',
      parentConversationId: 'parent-1',
    })).toMatchObject({
      key: 'subflow',
      inferred: false,
    });

    expect(getConversationOrigin({
      source: 'schedule',
      plannedExecutionId: 'plan-1',
      parentConversationId: 'upstream-automation-run',
    })).toMatchObject({
      key: 'schedule',
      label: 'Automation',
      inferred: false,
    });
  });

  it('does not mislabel legacy conversations with no origin evidence', () => {
    expect(getConversationOrigin({})).toMatchObject({
      key: 'unknown',
      label: 'Unknown origin',
      inferred: true,
    });
  });
});
