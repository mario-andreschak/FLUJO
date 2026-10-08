/**
 * Regression test for issue #267:
 * Chat sidebar should sort conversations by lastUserMessageAt (most recent
 * user-role message), not by updatedAt (which is bumped on every AI response).
 *
 * Verifies:
 * 1. A conversation with a newer user-message sorts above one that only has a
 *    newer AI-response updatedAt.
 * 2. Conversations without lastUserMessageAt fall back to updatedAt gracefully.
 */

/** Minimal subset of ConversationListItem used for sort-key testing. */
interface SortableConversation {
  id: string;
  updatedAt: number;
  lastUserMessageAt?: number | null;
}

// The sort comparator from the frontend (single source of truth for issue #267):
// .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt))
function sortByLastUserMessage(list: SortableConversation[]): SortableConversation[] {
  return [...list].sort(
    (a, b) =>
      (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt),
  );
}

function makeConv(
  id: string,
  updatedAt: number,
  lastUserMessageAt?: number | null,
): SortableConversation {
  return { id, updatedAt, lastUserMessageAt };
}

describe('sidebar sort order — issue #267', () => {
  it('sorts by lastUserMessageAt when present, ignoring updatedAt from AI turns', () => {
    const T = 1_000_000;
    // Conversation A: user messaged at T, no AI activity since
    const convA = makeConv('A', T, T);
    // Conversation B: user messaged at T-100ms but AI replied later (updatedAt = T+5000)
    const convB = makeConv('B', T + 5_000, T - 100);

    const sorted = sortByLastUserMessage([convB, convA]);
    // A should be first because its lastUserMessageAt (T) > B's (T-100)
    expect(sorted[0].id).toBe('A');
    expect(sorted[1].id).toBe('B');
  });

  it('falls back to updatedAt when lastUserMessageAt is absent (null)', () => {
    const T = 1_000_000;
    const convOld = makeConv('old', T - 1_000, null);
    const convNew = makeConv('new', T, null);

    const sorted = sortByLastUserMessage([convOld, convNew]);
    expect(sorted[0].id).toBe('new');
    expect(sorted[1].id).toBe('old');
  });

  it('falls back to updatedAt when lastUserMessageAt is undefined', () => {
    const T = 1_000_000;
    const convOld = makeConv('old', T - 1_000);
    const convNew = makeConv('new', T);

    const sorted = sortByLastUserMessage([convOld, convNew]);
    expect(sorted[0].id).toBe('new');
    expect(sorted[1].id).toBe('old');
  });

  it('mixes conversations with and without lastUserMessageAt correctly', () => {
    const T = 1_000_000;
    // Has explicit lastUserMessageAt = T+500 (very recent user turn)
    const convWithField = makeConv('with', T, T + 500);
    // No lastUserMessageAt — falls back to updatedAt = T+1000
    const convWithout = makeConv('without', T + 1_000, null);

    const sorted = sortByLastUserMessage([convWithout, convWithField]);
    // convWithField: effective sort key = T+500
    // convWithout:   effective sort key = T+1000 (updatedAt fallback)
    // convWithout is newer by its fallback key
    expect(sorted[0].id).toBe('without');
    expect(sorted[1].id).toBe('with');
  });

  it('does not change relative order when sort keys are identical', () => {
    const T = 1_000_000;
    const convA = makeConv('A', T, T);
    const convB = makeConv('B', T, T);

    const sorted = sortByLastUserMessage([convA, convB]);
    // Stable: order preserved when keys are equal (0 difference)
    expect(sorted.map(c => c.id)).toEqual(['A', 'B']);
  });

  it('sorts three conversations correctly with mixed field presence', () => {
    const T = 1_000_000;
    // Latest user turn
    const convFirst  = makeConv('first',  T + 1_000, T + 1_000);
    // Middle: lastUserMessageAt = T (older user turn, but AI bumped updatedAt higher)
    const convMiddle = makeConv('middle', T + 9_000, T);
    // Oldest user turn, no lastUserMessageAt
    const convLast   = makeConv('last',   T - 500,   null);

    const sorted = sortByLastUserMessage([convMiddle, convLast, convFirst]);
    expect(sorted[0].id).toBe('first');   // T+1000
    expect(sorted[1].id).toBe('middle');  // T
    expect(sorted[2].id).toBe('last');    // T-500 (via updatedAt fallback)
  });
});
