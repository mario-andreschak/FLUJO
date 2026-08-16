import { summarizeConversation } from '@/backend/execution/flow/conversationSummaryStore';
import type { SharedState } from '@/backend/execution/flow/types';

const state = (overrides: Partial<SharedState> = {}): SharedState => ({
  trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
  messages: [],
  flowId: 'child-flow',
  conversationId: 'child-conversation',
  title: 'Child',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
} as SharedState);

describe('conversation summary session visibility (issue #390)', () => {
  it('projects resolved session metadata from the authoritative child lane', () => {
    const summary = summarizeConversation(state({
      subflowLane: {
        laneIndex: 0,
        sessionKey: 'writer-main',
        sessionIdentity: 'parent::node::writer-main',
        sessionVisit: 2,
      },
    }), 'fallback');

    expect(summary).toMatchObject({
      id: 'child-conversation',
      sessionKey: 'writer-main',
      sessionIdentity: 'parent::node::writer-main',
    });
  });

  it('omits session metadata for ordinary and legacy conversations', () => {
    const summary = summarizeConversation(state(), 'fallback');

    expect(summary).not.toHaveProperty('sessionKey');
    expect(summary).not.toHaveProperty('sessionIdentity');
  });
});
