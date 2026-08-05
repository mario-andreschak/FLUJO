import {
  ConversationCursorError,
  paginateConversationSummaries,
} from '@/backend/execution/flow/conversationListPage';
import type { ConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';

const summary = (
  id: string,
  activityAt: number,
  updatedAt = activityAt,
): ConversationSummary => ({
  id,
  title: id,
  flowId: null,
  createdAt: 1,
  updatedAt,
  lastUserMessageAt: activityAt,
});

describe('conversation sidebar keyset pagination', () => {
  it('returns activity-descending pages and a cursor only while more rows remain', () => {
    const conversations = [summary('old', 10), summary('new', 30), summary('middle', 20)];

    const first = paginateConversationSummaries(conversations, 2);
    expect(first.items.map((item) => item.id)).toEqual(['new', 'middle']);
    expect(first).toMatchObject({ total: 3, hasMore: true });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = paginateConversationSummaries(conversations, 2, first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual(['old']);
    expect(second).toMatchObject({ total: 3, hasMore: false });
    expect(second.nextCursor).toBeUndefined();
  });

  it('does not duplicate or skip older rows when a new conversation is inserted between requests', () => {
    const original = [summary('c', 30), summary('b', 20), summary('a', 10)];
    const first = paginateConversationSummaries(original, 2);

    const second = paginateConversationSummaries(
      [summary('new-top', 40), ...original],
      2,
      first.nextCursor,
    );

    expect(first.items.map((item) => item.id)).toEqual(['c', 'b']);
    expect(second.items.map((item) => item.id)).toEqual(['a']);
  });

  it('uses the id as a deterministic tie-breaker', () => {
    const first = paginateConversationSummaries(
      [summary('gamma', 10), summary('alpha', 10), summary('beta', 10)],
      2,
    );
    const second = paginateConversationSummaries(
      [summary('gamma', 10), summary('alpha', 10), summary('beta', 10)],
      2,
      first.nextCursor,
    );

    expect(first.items.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(second.items.map((item) => item.id)).toEqual(['gamma']);
  });

  it('rejects malformed cursors', () => {
    expect(() => paginateConversationSummaries([summary('a', 1)], 1, 'not-a-cursor'))
      .toThrow(ConversationCursorError);
  });
});
